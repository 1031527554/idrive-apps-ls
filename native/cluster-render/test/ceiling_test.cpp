/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the remembered upload ceiling (ceiling_memory.h) and the
 * upload trace (link_trace.h): runs with no removal leave nothing behind;
 * a removal lowers the remembered ceiling one step below its level, kept
 * across runs with the governor starting there; three clean runs, then a
 * probe one step up, remembered when clean, barred again with the count
 * started over when removed, tried again when too short; never above
 * upload_kb_per_s, never below the floor; reaching upload_kb_per_s removes
 * the file; another firmware or KOMBI variant drops it, an unknown one
 * does not; a malformed or missing file is no ceiling, lines it does not
 * know are skipped; a ceiling set in local_conf leaves the file alone; a
 * read-only or full file system loses the write silently, every
 * descriptor opened is closed, nothing is written when nothing changes;
 * the firmware and coding readers. The send queue read from /proc/net/tcp
 * and tcp6 tables, loopback and other states left out; the 30 s before a
 * removal and the minute's summary. */
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include "../src/ceiling_memory.h"
#include "../src/governor.h"
#include "../src/link_trace.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static std::string dir;

static std::string slurp(const std::string &path)
{
    std::ifstream in(path);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

static void put(const std::string &path, const std::string &text)
{
    std::ofstream(path) << text;
}

static bool exists(const std::string &path) { return access(path.c_str(), F_OK) == 0; }

/* The file calls, counted, and made to fail with fail_errno. */
static int opens, closes, writes, fail_errno;
static int count_open(const char *p, int f, mode_t m)
{
    if (fail_errno) {
        errno = fail_errno;
        return -1;
    }
    const int fd = ::open(p, f, m);
    if (fd >= 0)
        opens++;
    return fd;
}
static ssize_t count_write(int fd, const void *b, size_t n)
{
    writes++;
    return ::write(fd, b, n);
}
static int count_close(int fd)
{
    closes++;
    return ::close(fd);
}

static CeilingSettings settings(const std::string &name)
{
    CeilingSettings s;
    s.path = dir + "/" + name;
    s.firmware = "BMW MGU P18_23w44.2-1-3 mgu-high";
    s.kombi = "7";
    s.max_kb = 5500;
    s.floor_kb = 2000;
    s.step_kb = 500;
    return s;
}

static const int64_t kMin = 60000;

/* One run: the memory read, minutes shown, and a removal the governor
 * counted at removal_kb (0: none) after removal_after minutes. Returns the
 * run's start ceiling. */
static uint64_t run(const CeilingSettings &s, int minutes, uint64_t removal_kb = 0, int removal_after = 0)
{
    CeilingMemory m(s);
    const uint64_t start = m.start_kb();
    for (int i = 0; i < minutes; i++)
        m.update(kMin, removal_kb && i >= removal_after ? removal_kb : 0);
    return start;
}

static void nothing_without_removal()
{
    const CeilingSettings s = settings("none");
    writes = 0;
    for (int i = 0; i < 5; i++)
        run(s, 30);
    ok("runs with no removal: 5500 every time, no file, nothing written",
       run(s, 0) == 5500 && !exists(s.path) && writes == 0);
}

static void remembered()
{
    const CeilingSettings s = settings("remembered");
    const uint64_t first = run(s, 15, 5500, 5);
    CeilingRecord r;
    const bool parsed = parse_ceiling(slurp(s.path), &r);
    ok("a removal at 5500: remembered 5000, its firmware and KOMBI variant with it",
       first == 5500 && parsed && r.ceiling_kb == 5000 && r.clean == 0 && r.firmware == s.firmware && r.kombi == "7");
    ok("the next run starts at 5000", run(s, 0) == 5000);
    run(s, 3, 5000);
    ok("a removal at 5000 in it: 4500", run(s, 0) == 4500);
    run(s, 3, 4000);
    ok("a removal at 4000 (or below) lowers it too: 3500", run(s, 0) == 3500);
    run(s, 3, 4000);
    ok("a removal above the remembered ceiling never raises it", run(s, 0) == 3500);
    for (int i = 0; i < 4; i++)
        run(s, 3, 2000);
    ok("never below the floor: a removal at 2000 keeps 2000", run(s, 0) == 2000);

    /* The governor starting at the remembered ceiling. */
    CeilingMemory m(settings("remembered"));
    GovernorConfig gc;
    gc.start_bps = m.start_kb() * 1024;
    Governor g(gc);
    ok("the governor starts at it, its ceiling it, the configured one 5500",
       g.cap() == 2000 * 1024 && g.ceiling() == 2000 * 1024 && g.max() == 5500 * 1024 &&
           g.reason() == "remembered ceiling");
}

static void probing()
{
    const CeilingSettings s = settings("probe");
    run(s, 20, 5500, 0);
    run(s, 9);
    CeilingRecord r;
    parse_ceiling(slurp(s.path), &r);
    ok("a run with 9 min shown is not clean", r.ceiling_kb == 5000 && r.clean == 0);
    writes = 0;
    run(s, 10);
    run(s, 12);
    parse_ceiling(slurp(s.path), &r);
    const bool two = r.clean == 2 && writes == 2;
    ok("10 min shown and no removal: a clean run, one write each", two);
    ok("after 2 clean runs no probe yet", run(s, 10) == 5000);   /* the third */
    parse_ceiling(slurp(s.path), &r);
    ok("3 of 3", r.clean == 3);
    ok("the fourth run probes one step up: 5500", run(s, 5) == 5500);
    parse_ceiling(slurp(s.path), &r);
    ok("too short to tell: nothing changes, the next probes again", r.ceiling_kb == 5000 && r.clean == 3);
    ok("probing again", run(s, 20, 5500, 6) == 5500);
    parse_ceiling(slurp(s.path), &r);
    ok("removed at the probe: 5000 stays, the count starts over", r.ceiling_kb == 5000 && r.clean == 0);
    for (int i = 0; i < 3; i++)
        run(s, 11);
    ok("three clean runs later the probe again", run(s, 15) == 5500);
    ok("clean at 5500, which is upload_kb_per_s: the file goes, 5500 from now on",
       !exists(s.path) && run(s, 0) == 5500);

    const CeilingSettings t = settings("probe-low");
    run(t, 5, 3000);
    for (int i = 0; i < 3; i++)
        run(t, 10);
    const uint64_t probe = run(t, 10);
    parse_ceiling(slurp(t.path), &r);
    ok("from 2500: probe 3000, clean: remembered 3000, count 0", probe == 3000 && r.ceiling_kb == 3000 && r.clean == 0);

    CeilingSettings u = settings("probe-cap");
    put(u.path, "ceiling_kb 5300\nclean_runs 3\n");
    ok("a probe never goes above upload_kb_per_s", run(u, 0) == 5500);
    u.max_kb = 4000;
    ok("a remembered ceiling above upload_kb_per_s: upload_kb_per_s", run(u, 0) == 4000);
    put(u.path, "ceiling_kb 1000\nclean_runs 0\n");
    ok("one below the floor: the floor", run(u, 0) == 2000);
}

static void reset()
{
    CeilingSettings s = settings("reset");
    run(s, 5, 5500);
    CeilingSettings fw = s;
    fw.firmware = "BMW MGU P18_24w10.1-1-1 mgu-high";
    ok("another firmware drops it: 5500, the file gone", run(fw, 0) == 5500 && !exists(s.path));
    run(s, 5, 5500);
    CeilingSettings kombi = s;
    kombi.kombi = "9";
    ok("another KOMBI variant drops it", run(kombi, 0) == 5500 && !exists(s.path));
    run(s, 5, 5500);
    CeilingSettings unknown = s;
    unknown.kombi = "";
    unknown.firmware = "";
    ok("unknown ones keep it", run(unknown, 0) == 5000);
    CeilingRecord r;
    parse_ceiling(slurp(s.path), &r);
    ok("and the file keeps the known ones", r.firmware == s.firmware && r.kombi == "7");
    put(s.path, "ceiling_kb 4000\nclean_runs 1\n");
    ok("a file without them (older) is kept", run(s, 0) == 4000);
}

static void malformed()
{
    const CeilingSettings s = settings("bad");
    const char *bad[] = {"", "garbage\n", "ceiling_kb \n", "ceiling_kb 0\n", "ceiling_kb 4x00\n", "ceiling_kb 99999999\n",
                         "ceiling_kb 4000\nclean_runs -1\n", "\x01\x02\xff"};
    bool all = true;
    for (const char *b : bad) {
        put(s.path, b);
        all = all && run(s, 0) == 5500;
    }
    ok("a malformed file: no remembered ceiling", all);
    put(s.path, "# a newer version's\nceiling_kb 4500\nclean_runs 7\nmargin_kb 300\nfirmware " + s.firmware +
                    "\nkombi_variant 7\n");
    ok("lines it does not know are skipped; clean runs past 3 are 3: a probe", run(s, 0) == 5000);
    unlink(s.path.c_str());
    ok("a missing file: 5500", run(s, 0) == 5500);
    CeilingRecord r;
    r.ceiling_kb = 3500;
    r.clean = 2;
    r.firmware = "a b";
    r.kombi = "7";
    CeilingRecord back;
    ok("format and parse round-trip", parse_ceiling(format_ceiling(r), &back) && back.ceiling_kb == 3500 &&
                                          back.clean == 2 && back.firmware == "a b" && back.kombi == "7");
}

static void user_set()
{
    CeilingSettings s = settings("user");
    run(s, 5, 5500);
    const std::string before = slurp(s.path);
    s.user_set = true;
    s.max_kb = 5500;
    writes = 0;
    ok("upload_kb_per_s in local_conf: the ceiling, the remembered one not used", run(s, 20, 5500) == 5500);
    ok("and the file is left as it was", slurp(s.path) == before && writes == 0);
    CeilingMemory m(s);
    ok("the status says so", m.status_text().find("local_conf") != std::string::npos);
}

static void file_safety()
{
    const CeilingSettings s = settings("safe");
    opens = closes = 0;
    run(s, 5, 5500);
    run(s, 12);
    run(s, 3, 5000);
    ok("every descriptor opened is closed again", opens == 3 && closes == 3);
    ok("no temporary file left", !exists(s.path + ".tmp"));
    writes = 0;
    run(s, 3, 5000);
    ok("a removal that changes nothing writes nothing", writes == 0);
    fail_errno = EROFS;
    run(s, 3, 4500);
    ok("read-only: the write is lost, the run goes on", run(s, 0) == 4500);
    fail_errno = ENOSPC;
    run(s, 3, 4500);
    fail_errno = 0;
    ok("full: likewise; the next run reads what is there", run(s, 0) == 4500);
    const CeilingSettings missing = settings("no-such-dir/upload-ceiling");
    run(missing, 3, 5500);
    ok("a directory that is not there: nothing written, nothing breaks", run(missing, 0) == 5500);
    CeilingSettings off = settings("off");
    off.path = "";
    CeilingMemory m(off);
    m.update(kMin * 30, 5500);
    ok("no path: nothing remembered", m.start_kb() == 5500 && m.status_text().empty() && !exists(dir + "/off"));
}

static void status()
{
    const CeilingSettings s = settings("status");
    {
        CeilingMemory m(s);
        ok("none remembered", m.status_text() == "upload ceiling: none remembered\n");
    }
    run(s, 5, 5500);
    {
        CeilingMemory m(s);
        ok("remembered", m.status_text() == "upload ceiling: 5000 KB/s remembered, 0 of 3 clean runs before a probe\n");
    }
    for (int i = 0; i < 3; i++)
        run(s, 10);
    CeilingMemory m(s);
    ok("probing", m.status_text() == "upload ceiling: probing 5500 KB/s this run, 5000 remembered\n");
}

static void readers()
{
    const std::string etc = dir + "/etc";
    mkdir(etc.c_str(), 0755);
    ok("no files: unknown firmware", firmware_id(etc).empty());
    put(etc + "/os-release", "NAME=x\nPRETTY_NAME=\"BMW MGU 23w44\"\n");
    ok("os-release's PRETTY_NAME", firmware_id(etc) == "BMW MGU 23w44");
    put(etc + "/os-release-id-dlt", "BMW MGU P18_23w44.2-1-3 mgu-high\nmore\n");
    ok("os-release-id-dlt's first line first", firmware_id(etc) == "BMW MGU P18_23w44.2-1-3 mgu-high");

    std::string coding(0x1030, '\0');
    coding[0x28] = 0x09;
    coding[0x2c + 0x75a] = (char)(7 << 1 | 1);
    put(dir + "/coding", coding);
    ok("KI_KOMBI_VARIANT from a valid coding image", kombi_variant(dir + "/coding") == "7");
    coding[0x28] = 0x01;
    put(dir + "/coding", coding);
    ok("a coding not valid: unknown", kombi_variant(dir + "/coding").empty());
    put(dir + "/coding", "short");
    ok("the wrong size: unknown", kombi_variant(dir + "/coding").empty() && kombi_variant(dir + "/none").empty());
}

static const char kTcp[] =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
    "   0: 0100007F:1F90 0100007F:C350 01 00F00000:00000000 00:00000000 00000000  5000        0 1 1\n"
    "   1: 63C730A0:C001 61C730A0:7725 01 00042000:00000000 01:00000014 00000000  5000        0 2 1\n"
    "   2: 63C730A0:C002 60C730A0:7725 01 00001000:00000000 00:00000000 00000000  5000        0 3 1\n"
    "   3: 63C730A0:C003 60C730A0:7726 0A 00F00000:00000000 00:00000000 00000000  5000        0 4 1\n";
static const char kTcp6[] =
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr "
    "tm->when retrnsmt   uid  timeout inode\n"
    "   0: 00000000000000000000000001000000:1F90 00000000000000000000000001000000:C350 01 00F00000:00000000 00:0 0 0 0 1 1\n"
    "   1: 0000000000000000FFFF000063C730A0:C004 0000000000000000FFFF00000100007F:7725 01 00F00000:00000000 00:0 0 0 0 1 1\n"
    "   2: 0000000000000000FFFF000063C730A0:C005 0000000000000000FFFF000061C730A0:7727 01 00002000:00000000 00:0 0 0 0 1 1\n";

static void send_queue()
{
    std::string peer;
    ok("the deepest established, loopback and listening left out: 270336 to 160.48.199.97:30501",
       deepest_send_queue(kTcp, &peer) == 0x42000 && peer == "160.48.199.97:30501");
    ok("tcp6: v4-mapped loopback left out", deepest_send_queue(kTcp6, &peer) == 0x2000);
    ok("an empty or unreadable table: none", deepest_send_queue("", &peer) == -1);
}

/* A trace shaped like the car's before a removal at 5000 KB/s: writes at
 * the cap, 15-20 holds and 9-11 ms a second, a send queue of 170-415 KB. */
static void trace()
{
    LinkTrace t;
    for (int i = 0; i < 40; i++) {
        LinkTrace::Second s;
        s.kb = 4990 + (i % 3) * 10;
        s.holds = 15 + i % 6;
        s.flush_ms = 9 + i % 3;
        s.queue_kb = i == 38 ? 415 : 170 + i;
        s.peer = "160.48.199.97:30501";
        t.add(s);
    }
    const std::string r = t.recent_text();
    ok("on a removal: the last 30 s in one line, oldest first", r.find("upload: the 30 s before, oldest first: KB 5000 ") == 0 &&
                                                                     r.find("; budget holds ") != std::string::npos &&
                                                                     r.find("; offer to flush ms ") != std::string::npos);
    ok("the send queue and its deepest peer", r.find("; send queue KB 180 ") != std::string::npos &&
                                                  r.find(" 415 209 (deepest to 160.48.199.97:30501)") != std::string::npos);
    const std::string m = t.minute_text();
    ok("the minute's summary",
       m.find("upload: in the last 40 s: 4999 KB/s on average, 5010 at most in a second, ") == 0 &&
           m.find("send queue 415 KB at most (to 160.48.199.97:30501)") != std::string::npos);
    ok("then empty until something is written", t.minute_text().empty());
    LinkTrace::Second unread;
    unread.kb = 100;
    t.add(unread);
    ok("a queue not read says so", t.minute_text().find("send queue not read") != std::string::npos &&
                                       t.recent_text().find(" -") != std::string::npos);
}

static void governor_level()
{
    Governor g{GovernorConfig()};
    int64_t now = 1000000;
    g.activity(now);
    g.evidence(Evidence::LinkStall, now);
    g.evidence(Evidence::LinkStall, now);
    g.tick(now + 100);
    ok("a step down with no removal: no removal level", g.cap() == 5000 * 1024 && g.removal_level() == 0);
    now += 20000;
    g.activity(now);
    g.evidence(Evidence::Removal, now);
    g.tick(now + 100);
    ok("a removal at 5000: its level 5000", g.removal_level() == 5000 * 1024);
    GovernorConfig low;
    low.start_bps = 1000 * 1024;
    ok("a start below the floor starts at the floor", Governor(low).cap() == 2000 * 1024);
    GovernorConfig high;
    high.start_bps = 9000 * 1024;
    ok("one above upload_kb_per_s at upload_kb_per_s", Governor(high).cap() == 5500 * 1024 &&
                                                         Governor(high).reason() == "ceiling");
}

int main()
{
    char tmpl[] = "/tmp/ceiling_test.XXXXXX";
    if (!mkdtemp(tmpl))
        return 1;
    dir = tmpl;
    ceiling_file_calls.open_file = count_open;
    ceiling_file_calls.write_file = count_write;
    ceiling_file_calls.close_file = count_close;
    nothing_without_removal();
    remembered();
    probing();
    reset();
    malformed();
    user_set();
    file_safety();
    status();
    readers();
    send_queue();
    trace();
    governor_level();
    std::string rm = "rm -rf " + dir;
    if (std::system(rm.c_str()) != 0)
        failures++;
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
