/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "link_trace.h"

#include <cstdio>
#include <cstdlib>
#include <sstream>

namespace crs {

namespace {

/* "0100007F:1F90" (IPv4, little-endian hex) or 32 hex digits (IPv6). */
bool loopback(const std::string &addr)
{
    const std::string host = addr.substr(0, addr.find(':'));
    if (host.size() == 8)
        return host.compare(6, 2, "7F") == 0;   /* 127.x.x.x */
    if (host.size() == 32)
        return host == "00000000000000000000000001000000" ||                       /* ::1 */
               (host.compare(0, 24, "0000000000000000FFFF0000") == 0 && host.compare(30, 2, "7F") == 0);
    return false;
}

std::string peer_text(const std::string &addr)
{
    const size_t colon = addr.find(':');
    if (colon != 8)
        return addr;
    const unsigned long ip = std::strtoul(addr.substr(0, 8).c_str(), nullptr, 16);
    const unsigned long port = std::strtoul(addr.substr(9).c_str(), nullptr, 16);
    char b[32];
    std::snprintf(b, sizeof b, "%lu.%lu.%lu.%lu:%lu", ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, ip >> 24, port);
    return b;
}

void series(std::string *s, const char *name, const std::deque<LinkTrace::Second> &d,
            int64_t (*get)(const LinkTrace::Second &))
{
    *s += name;
    for (const LinkTrace::Second &x : d) {
        const int64_t v = get(x);
        *s += v < 0 ? std::string(" -") : " " + std::to_string((long long)v);
    }
}

}  // namespace

int64_t deepest_send_queue(const std::string &table, std::string *peer)
{
    std::istringstream in(table);
    std::string line;
    int64_t best = -1;
    std::getline(in, line);   /* the header */
    while (std::getline(in, line)) {
        std::istringstream f(line);
        std::string sl, local, remote, st, queues;
        if (!(f >> sl >> local >> remote >> st >> queues) || st != "01" || loopback(remote))
            continue;
        const int64_t tx = (int64_t)std::strtoull(queues.substr(0, queues.find(':')).c_str(), nullptr, 16);
        if (tx > best) {
            best = tx;
            *peer = peer_text(remote);
        }
    }
    return best;
}

void LinkTrace::add(const Second &s)
{
    recent_.push_back(s);
    while (recent_.size() > (size_t)kSeconds)
        recent_.pop_front();
    minute_.push_back(s);
}

std::string LinkTrace::recent_text() const
{
    std::string s = "upload: the " + std::to_string(recent_.size()) + " s before, oldest first:";
    series(&s, " KB", recent_, [](const Second &x) { return (int64_t)x.kb; });
    series(&s, "; budget holds", recent_, [](const Second &x) { return (int64_t)x.holds; });
    series(&s, "; offer to flush ms", recent_, [](const Second &x) { return x.flush_ms; });
    series(&s, "; send queue KB", recent_, [](const Second &x) { return x.queue_kb; });
    const Second *deepest = nullptr;
    for (const Second &x : recent_)
        if (x.queue_kb >= 0 && (!deepest || x.queue_kb > deepest->queue_kb))
            deepest = &x;
    if (deepest)
        s += " (deepest to " + deepest->peer + ")";
    return s;
}

std::string LinkTrace::minute_text()
{
    uint64_t kb = 0, top = 0, holds = 0;
    int64_t queue = -1, queue_sum = 0, queue_n = 0;
    std::string peer;
    for (const Second &x : minute_) {
        kb += x.kb;
        top = x.kb > top ? x.kb : top;
        holds += x.holds;
        if (x.queue_kb >= 0) {
            queue_sum += x.queue_kb;
            queue_n++;
            if (x.queue_kb > queue) {
                queue = x.queue_kb;
                peer = x.peer;
            }
        }
    }
    const size_t n = minute_.size();
    minute_.clear();
    if (!kb)
        return "";
    char b[256];
    std::snprintf(b, sizeof b, "upload: in the last %zu s: %llu KB/s on average, %llu at most in a second, %llu budget "
                               "holds; send queue ",
                  n, (unsigned long long)(kb / n), (unsigned long long)top, (unsigned long long)holds);
    std::string s = b;
    if (queue < 0)
        return s + "not read";
    std::snprintf(b, sizeof b, "%lld KB at most (to %s), %lld on average", (long long)queue, peer.c_str(),
                  (long long)(queue_sum / queue_n));
    return s + b;
}

}  // namespace crs
