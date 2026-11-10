// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the picture pace (picture_pace.h): off, every frame gets a
 * picture; at 15 a second from a 30 fps stream, every other frame, a frame a
 * few ms early still counts, and a skipped frame's late picture is due one
 * interval after the last picture. */
#include <cstdio>

#include "../src/picture_pace.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

/* Feeds frames at the given times; returns how many got a picture. */
static int run(PicturePace *p, const int64_t *t, int n)
{
    int pictures = 0;
    for (int i = 0; i < n; i++)
        if (p->due(t[i])) {
            p->took(t[i]);
            pictures++;
        }
    return pictures;
}

int main()
{
    int64_t t30[30];
    for (int i = 0; i < 30; i++)
        t30[i] = 1000 + i * 1000 / 30;   /* one second at 30 fps */

    PicturePace off;
    ok("off: every frame gets a picture", run(&off, t30, 30) == 30 && !off.on());
    ok("off: no late picture to wait for", off.late_in_ms(5000) == 0);

    PicturePace p15(15);
    ok("15: on", p15.on());
    ok("15 from 30 fps: every other frame (15)", run(&p15, t30, 30) == 15);

    PicturePace first(15);
    ok("the first frame gets a picture", first.due(123));

    PicturePace jitter(15);
    jitter.took(1000);
    ok("a frame 50 ms after the last picture (3/4 of 66) gets one", jitter.due(1050));
    ok("a frame 33 ms after does not", !jitter.due(1033));

    PicturePace late(15);
    late.took(1000);
    ok("a skipped frame's late picture: 66 ms after the last picture", late.late_in_ms(1033) == 33);
    ok("a late picture past its time is due now", late.late_in_ms(1100) == 0);

    late.reset();
    ok("after reset the next frame gets a picture", late.due(1001));

    PicturePace p30(30);
    int64_t t60[60];
    for (int i = 0; i < 60; i++)
        t60[i] = 1000 + i * 1000 / 60;
    ok("30 from 60 fps: every other frame (30)", run(&p30, t60, 60) == 30);

    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
