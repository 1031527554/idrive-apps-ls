// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host tests for the per-minute frame timing (frame_timing.h): how the RTP
 * access units ended, how long each waited after its last packet, how many
 * frames the decoder held, a minute at a time and since the start, and the
 * line the log and probe.txt show. */
#include "../src/frame_timing.h"

#include <cstdio>
#include <string>

using namespace woc;

static int failures;

#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main()
{
    FrameTiming t;
    CHECK(FrameTiming::describe(t.take_minute()) == "frames ended by the marker bit 0, by the next timestamp 0");

    /* Three frames ended by the next one's first packet, 30, 40 and 50 ms
     * after their last; one by its own marker, 0.5 ms after; one whose last
     * packet's arrival is unknown. */
    t.access_unit(false, 1000000, 1030000);
    t.access_unit(false, 1033000, 1073000);
    t.access_unit(false, 1066000, 1116000);
    t.access_unit(true, 1100000, 1100500);
    t.access_unit(false, -1, 1200000);
    for (uint32_t held : {0u, 0u, 2u, 1u})
        t.frame(held);
    FrameTiming::Minute m = t.take_minute();
    CHECK(m.by_marker == 1 && m.by_timestamp == 4);
    CHECK(m.hold_us.n == 4 && m.hold_us.sum == 120500 && m.hold_us.max == 50000);
    CHECK(m.held.n == 4 && m.held.sum == 3 && m.held.max == 2);
    CHECK(FrameTiming::describe(m) == "frames ended by the marker bit 1, by the next timestamp 4; handed to the "
                                      "decoder 30.1 ms on average after their last packet, 50.0 ms at most; the "
                                      "decoder held 0.8 frames on average, 2 at most");

    /* The next minute starts empty; the total keeps both. */
    m = t.take_minute();
    CHECK(m.by_marker == 0 && m.by_timestamp == 0 && m.hold_us.n == 0 && m.held.n == 0);
    t.access_unit(true, 2000000, 2000200);
    m = t.take_minute();
    CHECK(m.by_marker == 1 && m.hold_us.max == 200);
    CHECK(FrameTiming::describe(m) == "frames ended by the marker bit 1, by the next timestamp 0; handed to the "
                                      "decoder 0.2 ms on average after their last packet, 0.2 ms at most");
    const FrameTiming::Minute &all = t.total();
    CHECK(all.by_marker == 2 && all.by_timestamp == 4 && all.hold_us.n == 5 && all.held.n == 4);

    /* Frames only (a raw Annex-B feed has no RTP access units). */
    t.frame(0);
    CHECK(FrameTiming::describe(t.take_minute()) == "frames ended by the marker bit 0, by the next timestamp 0; "
                                                    "the decoder held 0.0 frames on average, 0 at most");

    if (failures) {
        std::printf("frame_timing_test: %d FAILED\n", failures);
        return 1;
    }
    std::printf("frame_timing_test: all passed\n");
    return 0;
}
