// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* When each frame reaches the decoder and leaves it, a minute at a time for
 * the log and since the start for probe.txt:
 *   - how each RTP access unit ended (rtp_h264.h): by the marker bit, with
 *     its last packet, or by the next timestamp, with the next frame's
 *     first packet;
 *   - the time from its last packet's arrival to its hand-off to the
 *     decoder: what a frame waits for the next one when the timestamp ends
 *     it;
 *   - at each frame out of the decoder, the access units it took in after
 *     that frame's own (VideoFrame::held): 0 when each frame comes out as
 *     it is decoded. A frame the decoder took and never output counts
 *     only for frames already waiting in it.
 * Counters only. Not thread-safe. */
#ifndef WOC_FRAME_TIMING_H
#define WOC_FRAME_TIMING_H

#include <stdint.h>
#include <cstdio>
#include <initializer_list>
#include <string>

#include "frame_clock.h"

namespace woc {

class FrameTiming {
public:
    struct Minute {
        uint32_t by_marker = 0, by_timestamp = 0;
        crk::Spread hold_us;   /* last packet's arrival to the hand-off */
        crk::Spread held;      /* access units taken after each frame out's own */
    };

    /* An RTP access unit handed to the decoder at now_us, its last packet
     * arrived at last_us (the same clock; < 0 unknown). */
    void access_unit(bool by_marker, int64_t last_us, int64_t now_us)
    {
        for (Minute *m : {&minute_, &total_}) {
            (by_marker ? m->by_marker : m->by_timestamp)++;
            if (last_us >= 0)
                m->hold_us.add(now_us - last_us);
        }
    }

    /* A frame out of the decoder; held < 0 unknown, not counted. */
    void frame(int32_t held)
    {
        if (held < 0)
            return;
        minute_.held.add(held);
        total_.held.add(held);
    }

    /* The counts since the last call. */
    Minute take_minute()
    {
        const Minute m = minute_;
        minute_ = Minute();
        return m;
    }

    const Minute &total() const { return total_; }

    /* "frames ended by the marker bit 0, by the next timestamp 1796; handed
     * to the decoder 33.2 ms on average after their last packet, 68.4 ms at
     * most; the decoder held 0.0 frames on average, 0 at most". The parts
     * with nothing to measure are left out. */
    static std::string describe(const Minute &m)
    {
        char line[320];
        int n = std::snprintf(line, sizeof line, "frames ended by the marker bit %u, by the next timestamp %u",
                              m.by_marker, m.by_timestamp);
        if (m.hold_us.n && n > 0 && (size_t)n < sizeof line)
            n += std::snprintf(line + n, sizeof line - n,
                               "; handed to the decoder %.1f ms on average after their last packet, %.1f ms at most",
                               (double)m.hold_us.sum / (double)m.hold_us.n / 1000.0, m.hold_us.max / 1000.0);
        if (m.held.n && n > 0 && (size_t)n < sizeof line)
            std::snprintf(line + n, sizeof line - n, "; the decoder held %.1f frames on average, %lld at most",
                          (double)m.held.sum / (double)m.held.n, (long long)m.held.max);
        return line;
    }

private:
    Minute minute_, total_;
};

}  // namespace woc

#endif
