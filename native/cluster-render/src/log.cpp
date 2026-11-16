/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "log.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>

namespace cld {

int log_verbose;
int log_errors;
const char *log_name = "cluster-demo";

static int open_file(const char *path, int flags, mode_t mode) { return open(path, flags, mode); }
LogFileCalls log_file_calls = {open_file, ::write, ::rename};

namespace {
const size_t BACKLOG = 60;
std::mutex lines_mutex;
std::deque<std::string> lines;   /* the newest BACKLOG lines */
uint64_t lines_total;            /* sequence number of the newest line */

/* The log file (log_to_file), under file_mutex. It is opened for each line
 * and closed again, so no descriptor stays open on its file system between
 * lines: remounting that file system read-only (at each head-unit shutdown)
 * fails while one is open for writing. */
std::mutex file_mutex;
bool file_on;
std::string file_path;
size_t file_max;

/* A file system that is read-only, full or over quota. */
bool dropped(int err) { return err == EROFS || err == ENOSPC || err == EDQUOT; }

/* Any other failure: the one warning, straight to stderr (log() would come
 * back here), and file logging off; under file_mutex. */
void file_fail(const char *what, int err)
{
    if (dropped(err))
        return;
    std::fprintf(stderr, "W %s: log file %s: %s: %s; logging to the journal only\n", log_name, file_path.c_str(),
                 what, strerror(err));
    file_on = false;
}

/* Appends one line, renaming the file to .1 first when the line would take
 * it past file_max; whether the line was written. Under file_mutex. */
bool file_write(char level, const char *text)
{
    if (!file_on)
        return false;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    std::string line = utc_time((int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
    line += ' ';
    line += level;
    line += ' ';
    line += text;
    line += '\n';
    struct stat st;
    size_t size = stat(file_path.c_str(), &st) == 0 ? (size_t)st.st_size : 0;
    if (size > 0 && size + line.size() > file_max) {
        if (log_file_calls.rename_file(file_path.c_str(), (file_path + ".1").c_str()) != 0) {
            file_fail("rename", errno);
            return false;
        }
        size = 0;
    }
    const int fd = log_file_calls.open_file(file_path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
    if (fd < 0) {
        file_fail("open", errno);
        return false;
    }
    const ssize_t n = log_file_calls.write_file(fd, line.data(), line.size());
    const int err = n < 0 ? errno : ENOSPC;   /* a short write: the file system is full */
    /* a short write's part taken back, so the next line starts on its own;
     * should that fail too, the part stays (the if only checks the result) */
    if (n > 0 && n != (ssize_t)line.size() && ftruncate(fd, (off_t)size) != 0) {
    }
    close(fd);
    if (n != (ssize_t)line.size()) {
        file_fail("write", err);
        return false;
    }
    return true;
}
}  // namespace

int64_t now_ms()
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void log(char level, const char *fmt, ...)
{
    if (level == 'E')
        log_errors++;
    char line[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    std::fprintf(stderr, "%c %s: %s\n", level, log_name, line);
    {
        std::lock_guard<std::mutex> lock(lines_mutex);
        lines.push_back(line);
        if (lines.size() > BACKLOG)
            lines.pop_front();
        lines_total++;
    }
    std::lock_guard<std::mutex> lock(file_mutex);
    file_write(level, line);
}

size_t log_file_cap(long kb)
{
    if (kb < 16 || kb > 16384) {
        log('W', "log_file_kb %ld is not from 16 to 16384; 512 it is", kb);
        kb = 512;
    }
    return (size_t)kb * 1024;
}

bool log_to_file(const std::string &path, size_t max_bytes, const char *name, const char *version)
{
    std::lock_guard<std::mutex> lock(file_mutex);
    file_path = path;
    file_max = max_bytes;
    file_on = !path.empty();
    char line[256];
    std::snprintf(line, sizeof line, "start: %s%s%s, pid %d", name, version && *version ? " " : "",
                  version ? version : "", (int)getpid());
    return file_write('I', line);
}

std::string utc_time(int64_t unix_ms)
{
    const time_t secs = (time_t)(unix_ms / 1000);
    struct tm tm;
    gmtime_r(&secs, &tm);
    char out[80];   /* the widest ints the format can take */
    std::snprintf(out, sizeof out, "%04d-%02d-%02d %02d:%02d:%02d.%03d", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec, (int)(unix_ms % 1000));
    return out;
}

void log_lines_since(uint64_t *seq, std::vector<std::string> *out)
{
    std::lock_guard<std::mutex> lock(lines_mutex);
    uint64_t first = lines_total - lines.size();   /* sequence number before the oldest kept line */
    for (uint64_t n = std::max(*seq, first); n < lines_total; n++)
        out->push_back(lines[n - first]);
    *seq = lines_total;
}

}  // namespace cld
