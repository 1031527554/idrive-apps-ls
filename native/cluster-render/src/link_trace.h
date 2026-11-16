/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* What the upload looked like second by second, for the log (README.md
 * "Upload budget"): the bytes the layers wrote, their budget holds, the
 * average time from a frame's offer to its flush, and the deepest TCP send
 * queue among the head unit's connections with the peer it goes to. On a
 * removal the last kSeconds go to the log in one line; once a minute, a
 * summary. Nothing here steers the cap: on the car none of these rose
 * reliably before a removal (README.md). */
#ifndef CRS_LINK_TRACE_H
#define CRS_LINK_TRACE_H

#include <stdint.h>

#include <deque>
#include <string>
#include <vector>

namespace crs {

/* The deepest send queue (tx_queue, bytes) among the established
 * connections of a /proc/net/tcp or tcp6 table, loopback left out, and its
 * peer ("a.b.c.d:port", or the table's hex for IPv6); -1 when none. */
int64_t deepest_send_queue(const std::string &table, std::string *peer);

class LinkTrace {
public:
    static const int kSeconds = 30;

    struct Second {
        uint64_t kb = 0;          /* written */
        uint64_t holds = 0;       /* budget holds */
        int64_t flush_ms = -1;    /* offer to flush on average; -1: no frame */
        int64_t queue_kb = -1;    /* the deepest send queue; -1: not read */
        std::string peer;
    };

    void add(const Second &s);
    /* The last kSeconds, oldest first, in one line. */
    std::string recent_text() const;
    /* The seconds since the last call, in one line; "" when nothing was
     * written. */
    std::string minute_text();

private:
    std::deque<Second> recent_;
    std::vector<Second> minute_;
};

}  // namespace crs

#endif
