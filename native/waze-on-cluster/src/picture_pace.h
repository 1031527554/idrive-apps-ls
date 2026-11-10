// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Which decoded frames get a picture, at most picture_fps a second.
 *
 * Every frame is decoded, since the next ones refer to it, but a picture
 * (VPP, its copy to system memory, the packing and the hand-off,
 * decoder_msdk.h) is what costs the head unit's CPU, and a moving map
 * changes nearly every picture. The cluster takes at most target_fps
 * updates a second (map_feed.h), so with a phone sending 30 frames a second
 * and target_fps 15, half the pictures are made for nothing.
 *
 * A frame gets a picture when it is the first, or decoded at least 3/4 of
 * an interval (1000 / picture_fps ms) after the last picture: with 30 frames
 * a second and picture_fps 15 that is every other frame, and a frame a few
 * ms early is not skipped for it. A frame skipped here may be the last one
 * for a while (a still map sends a frame only when it changes), so the
 * producer gives it its picture after all when no newer frame came by one
 * interval after the last picture (late_in_ms): the map is never left on an
 * older picture than the phone's last.
 *
 * picture_fps 0: every frame gets a picture. Not thread-safe: the decode
 * thread's. */
#ifndef WOC_PICTURE_PACE_H
#define WOC_PICTURE_PACE_H

#include <stdint.h>

namespace woc {

class PicturePace {
public:
    explicit PicturePace(unsigned fps = 0) { configure(fps); }

    void configure(unsigned fps)
    {
        interval_ms_ = fps ? 1000 / (int64_t)fps : 0;
        last_ms_ = -1;
    }

    bool on() const { return interval_ms_ > 0; }

    /* Whether a frame decoded at now_ms gets its picture. */
    bool due(int64_t now_ms) const
    {
        return interval_ms_ == 0 || last_ms_ < 0 || now_ms - last_ms_ >= interval_ms_ * 3 / 4;
    }

    /* A picture was made at now_ms. */
    void took(int64_t now_ms) { last_ms_ = now_ms; }

    /* The next picture comes whatever the time (the map shown again). */
    void reset() { last_ms_ = -1; }

    /* How long until a skipped frame, if still the newest, gets its picture
     * after all: one interval after the last picture; 0 when that is now or
     * past. */
    int64_t late_in_ms(int64_t now_ms) const
    {
        if (interval_ms_ == 0 || last_ms_ < 0)
            return 0;
        const int64_t left = last_ms_ + interval_ms_ - now_ms;
        return left > 0 ? left : 0;
    }

private:
    int64_t interval_ms_ = 0;
    int64_t last_ms_ = -1;
};

}  // namespace woc

#endif
