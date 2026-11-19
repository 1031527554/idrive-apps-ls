/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "ceiling_memory.h"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <sstream>

#include "log.h"

namespace crs {

CeilingFileCalls ceiling_file_calls = {
    [](const char *path, int flags, mode_t mode) { return ::open(path, flags, mode); },
    [](int fd, const void *buf, size_t n) { return ::write(fd, buf, n); },
    [](int fd) { return ::close(fd); },
    [](const char *from, const char *to) { return ::rename(from, to); },
    [](const char *path) { return ::unlink(path); },
};

namespace {

const uint64_t kMaxKb = 1048576;
const size_t kMaxFile = 4096;

/* The whole small file at path; false when it cannot be read. */
bool read_small(const std::string &path, std::string *out)
{
    const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return false;
    char buf[kMaxFile];
    size_t n = 0;
    for (;;) {
        const ssize_t r = ::read(fd, buf + n, sizeof buf - n);
        if (r < 0 && errno == EINTR)
            continue;
        if (r <= 0)
            break;
        n += (size_t)r;
        if (n == sizeof buf)
            break;
    }
    ::close(fd);
    out->assign(buf, n);
    return true;
}

/* One line of printable text, at most 120 characters. */
std::string clean_text(const std::string &s)
{
    std::string out;
    for (char c : s) {
        if (c == '\n' || c == '\r')
            break;
        out += (unsigned char)c < 0x20 || c == 0x7f ? '?' : c;
    }
    const size_t a = out.find_first_not_of(" \t"), b = out.find_last_not_of(" \t");
    out = a == std::string::npos ? "" : out.substr(a, b - a + 1);
    return out.substr(0, 120);
}

const char *or_unknown(const std::string &s) { return s.empty() ? "unknown" : s.c_str(); }

}  // namespace

bool parse_ceiling(const std::string &text, CeilingRecord *out)
{
    CeilingRecord r;
    std::istringstream in(text);
    std::string line;
    bool have = false;
    while (std::getline(in, line)) {
        const size_t sp = line.find(' ');
        const std::string key = line.substr(0, sp), value = sp == std::string::npos ? "" : line.substr(sp + 1);
        char *end = nullptr;
        if (key == "ceiling_kb") {
            const unsigned long long v = std::strtoull(value.c_str(), &end, 10);
            if (value.empty() || *end || v < 1 || v > kMaxKb)
                return false;
            r.ceiling_kb = v;
            have = true;
        } else if (key == "clean_runs") {
            const long v = std::strtol(value.c_str(), &end, 10);
            if (value.empty() || *end || v < 0)
                return false;
            r.clean = (int)std::min<long>(v, CeilingMemory::kCleanRuns);
        } else if (key == "firmware") {
            r.firmware = clean_text(value);
        } else if (key == "kombi_variant") {
            r.kombi = clean_text(value);
        }
    }
    if (!have)
        return false;
    *out = r;
    return true;
}

std::string format_ceiling(const CeilingRecord &r)
{
    std::string s = "ceiling_kb " + std::to_string((unsigned long long)r.ceiling_kb) + "\n";
    s += "clean_runs " + std::to_string(r.clean) + "\n";
    if (!r.firmware.empty())
        s += "firmware " + r.firmware + "\n";
    if (!r.kombi.empty())
        s += "kombi_variant " + r.kombi + "\n";
    return s;
}

std::string firmware_id(const std::string &etc_dir)
{
    std::string text;
    if (read_small(etc_dir + "/os-release-id-dlt", &text)) {
        const std::string id = clean_text(text);
        if (!id.empty())
            return id;
    }
    if (!read_small(etc_dir + "/os-release", &text))
        return "";
    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        if (line.compare(0, 12, "PRETTY_NAME=") != 0)
            continue;
        std::string v = line.substr(12);
        if (!v.empty() && (v[0] == '"' || v[0] == '\''))
            v = v.substr(1);
        if (!v.empty() && (v.back() == '"' || v.back() == '\''))
            v.pop_back();
        return clean_text(v);
    }
    return "";
}

std::string kombi_variant(const std::string &path)
{
    /* The coding image CodingShmApp publishes: a 0x2c byte header (flags at
     * 0x28, 0x09: valid) and the blocks; CodingKOMBI_HUD at block offset
     * 0x75a, KI_KOMBI_VARIANT bits 1-6 of its first byte. */
    const size_t kSize = 0x1030, kFlags = 0x28, kAt = 0x2c + 0x75a;
    const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return "";
    unsigned char b[kSize + 1];
    size_t n = 0;
    for (;;) {
        const ssize_t r = ::read(fd, b + n, sizeof b - n);
        if (r < 0 && errno == EINTR)
            continue;
        if (r <= 0)
            break;
        n += (size_t)r;
        if (n == sizeof b)
            break;
    }
    ::close(fd);
    if (n != kSize || (b[kFlags] & 0x0f) != 0x09)
        return "";
    return std::to_string((b[kAt] & 0x7e) >> 1);
}

CeilingMemory::CeilingMemory(const CeilingSettings &s) : s_(s), start_kb_(s.max_kb)
{
    if (s_.path.empty() || s_.max_kb == 0)
        return;
    if (s_.user_set) {
        log_info("upload: ceiling %llu KB/s from local_conf; no remembered ceiling used",
                 (unsigned long long)s_.max_kb);
        return;
    }
    active_ = true;
    std::string text;
    if (read_small(s_.path, &text) && !parse_ceiling(text, &rec_)) {
        log_warn("upload: %s is malformed: no remembered ceiling", s_.path.c_str());
        rec_ = CeilingRecord();
    }
    const bool fw = !s_.firmware.empty() && !rec_.firmware.empty() && s_.firmware != rec_.firmware;
    const bool kombi = !s_.kombi.empty() && !rec_.kombi.empty() && s_.kombi != rec_.kombi;
    if (rec_.ceiling_kb && (fw || kombi)) {
        log_info("upload: remembered ceiling %llu KB/s dropped: %s %s, now %s", (unsigned long long)rec_.ceiling_kb,
                 fw ? "firmware" : "KOMBI variant", fw ? rec_.firmware.c_str() : rec_.kombi.c_str(),
                 fw ? s_.firmware.c_str() : s_.kombi.c_str());
        rec_ = CeilingRecord();
        save("dropped");
    }
    if (!s_.firmware.empty())
        rec_.firmware = s_.firmware;
    if (!s_.kombi.empty())
        rec_.kombi = s_.kombi;
    if (!rec_.ceiling_kb) {
        log_info("upload: no remembered ceiling (firmware %s, KOMBI variant %s)", or_unknown(s_.firmware),
                 or_unknown(s_.kombi));
        return;
    }
    const uint64_t base = std::max(s_.floor_kb, std::min(rec_.ceiling_kb, s_.max_kb));
    start_kb_ = base;
    if (base < s_.max_kb && rec_.clean >= kCleanRuns) {
        probe_ = true;
        start_kb_ = std::min(base + s_.step_kb, s_.max_kb);
    }
    log_info("upload: remembered ceiling %llu KB/s, %d of %d clean runs at it%s; this run's ceiling %llu "
             "(firmware %s, KOMBI variant %s)",
             (unsigned long long)rec_.ceiling_kb, rec_.clean, kCleanRuns, probe_ ? ": probing one step above" : "",
             (unsigned long long)start_kb_, or_unknown(s_.firmware), or_unknown(s_.kombi));
}

void CeilingMemory::update(int64_t shown_ms, uint64_t removal_kb)
{
    if (!active_)
        return;
    if (shown_ms > 0)
        shown_ms_ += shown_ms;
    if (removal_kb && (!removal_kb_ || removal_kb < removal_kb_)) {
        removal_kb_ = removal_kb;
        counted_ = true;
        const uint64_t was =
            rec_.ceiling_kb ? std::max(s_.floor_kb, std::min(rec_.ceiling_kb, s_.max_kb)) : s_.max_kb;
        const uint64_t to =
            std::min(was, removal_kb > s_.floor_kb + s_.step_kb ? removal_kb - s_.step_kb : s_.floor_kb);
        if (to == rec_.ceiling_kb && rec_.clean == 0)
            return;
        log_warn("upload: remembered ceiling %llu KB/s (was %llu), clean runs 0 of %d: the display removed a "
                 "shown scene at %llu",
                 (unsigned long long)to, (unsigned long long)was, kCleanRuns, (unsigned long long)removal_kb);
        rec_.ceiling_kb = to;
        rec_.clean = 0;
        save("lowered");
        return;
    }
    if (counted_ || removal_kb_ || shown_ms_ < kCleanShownMs)
        return;
    counted_ = true;
    if (probe_) {
        rec_.ceiling_kb = start_kb_ >= s_.max_kb ? 0 : start_kb_;
        rec_.clean = 0;
        log_info("upload: a clean run at %llu KB/s: remembered ceiling %llu%s", (unsigned long long)start_kb_,
                 (unsigned long long)start_kb_, start_kb_ >= s_.max_kb ? ", upload_kb_per_s: nothing remembered" : "");
        save("raised");
    } else if (rec_.ceiling_kb && rec_.ceiling_kb < s_.max_kb) {
        rec_.clean = std::min(rec_.clean + 1, kCleanRuns);
        log_info("upload: a clean run at the remembered ceiling %llu KB/s: %d of %d", (unsigned long long)rec_.ceiling_kb,
                 rec_.clean, kCleanRuns);
        save("clean run");
    }
}

void CeilingMemory::save(const char *why)
{
    const CeilingFileCalls &c = ceiling_file_calls;
    int err = 0;
    if (!rec_.ceiling_kb || rec_.ceiling_kb >= s_.max_kb) {
        if (c.unlink_file(s_.path.c_str()) != 0 && errno != ENOENT)
            err = errno;
    } else {
        const std::string tmp = s_.path + ".tmp", text = format_ceiling(rec_);
        const int fd = c.open_file(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
        if (fd < 0) {
            err = errno;
        } else {
            errno = 0;
            const bool whole = c.write_file(fd, text.data(), text.size()) == (ssize_t)text.size();
            if (!whole)
                err = errno ? errno : EIO;
            if (c.close_file(fd) != 0 && !err)
                err = errno;
            if (!err && c.rename_file(tmp.c_str(), s_.path.c_str()) != 0)
                err = errno;
            if (err)
                c.unlink_file(tmp.c_str());
        }
    }
    if (!err || err == EROFS || err == ENOSPC || warned_)
        return;
    warned_ = true;
    log_warn("upload: %s: not written (%s): %s", s_.path.c_str(), why, strerror(err));
}

std::string CeilingMemory::status_text() const
{
    char b[200];
    if (s_.path.empty() || s_.max_kb == 0)
        return "";
    if (!active_)
        return "upload ceiling: upload_kb_per_s from local_conf; none remembered or used\n";
    if (!rec_.ceiling_kb)
        std::snprintf(b, sizeof b, "upload ceiling: none remembered\n");
    else if (probe_ && !counted_)
        std::snprintf(b, sizeof b, "upload ceiling: probing %llu KB/s this run, %llu remembered\n",
                      (unsigned long long)start_kb_, (unsigned long long)rec_.ceiling_kb);
    else
        std::snprintf(b, sizeof b, "upload ceiling: %llu KB/s remembered, %d of %d clean runs before a probe\n",
                      (unsigned long long)rec_.ceiling_kb, rec_.clean, kCleanRuns);
    return b;
}

}  // namespace crs
