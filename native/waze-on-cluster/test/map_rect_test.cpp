// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
#include "map_rect.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

using namespace woc;

int main()
{
    MapRect r;
    assert(!parse_map_rect("", &r) && !r.set());
    assert(!parse_map_rect("0,0,1088,480", &r) && r.set() && r.w == 1088 && r.h == 480);
    assert(r.fits(1088, 480) && !r.fits(1087, 480));
    assert(!parse_map_rect("40,20,900,338", &r) && r.x == 40 && r.y == 20 && r.fits(1088, 480));
    assert(!parse_map_rect("200,0,900,480", &r) && !r.fits(1088, 480));
    assert(parse_map_rect("1,2,3", &r) && !r.set());
    assert(parse_map_rect("0,0,1088,480x", &r));
    assert(parse_map_rect("0,0,8,8", &r));
    assert(parse_map_rect("0,0,5000,480", &r));
    printf("map_rect_test: ok\n");
    return 0;
}
