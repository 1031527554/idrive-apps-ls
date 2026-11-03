// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
#include "source_crop.h"

#include <stdio.h>
#include <stdlib.h>

using woc::SourceCrop;
using woc::parse_source_crop;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

int main()
{
    SourceCrop c;
    expect(parse_source_crop("", &c) == nullptr && !c.enabled(), "empty is off");
    expect(!c.applies(1920, 1080), "off applies to nothing");

    expect(parse_source_crop("1920x1080:0,0,1088,480", &c) == nullptr, "android auto cluster crop parses");
    expect(c.enabled() && c.seq_w == 1920 && c.seq_h == 1080, "sequence size");
    expect(c.x == 0 && c.y == 0 && c.w == 1088 && c.h == 480, "rect");
    expect(c.applies(1920, 1080), "applies to its sequence");
    expect(!c.applies(1088, 480), "not to carplay's map-sized stream");
    expect(!c.applies(1920, 900), "not to another size");

    expect(parse_source_crop("1920x1080:416,300,1088,480", &c) == nullptr && c.x == 416 && c.y == 300, "centred rect");
    expect(parse_source_crop("1920x1080:832,600,1088,480", &c) == nullptr, "rect reaching the corner");

    expect(parse_source_crop("1920x1080:834,600,1088,480", &c) != nullptr && !c.enabled(), "rect past the right edge");
    expect(parse_source_crop("1920x1080:0,602,1088,480", &c) != nullptr, "rect past the bottom");
    expect(parse_source_crop("1920x1080:1,0,1088,480", &c) != nullptr, "odd x");
    expect(parse_source_crop("1920x1080:0,0,1087,480", &c) != nullptr, "odd width");
    expect(parse_source_crop("1920x1080:0,0,8,480", &c) != nullptr, "too narrow");
    expect(parse_source_crop("1920x1080", &c) != nullptr, "no rect");
    expect(parse_source_crop("1920x1080:0,0,1088,480x", &c) != nullptr, "trailing text");
    expect(parse_source_crop("0x1080:0,0,16,16", &c) != nullptr, "zero sequence");

    if (failures)
        return 1;
    printf("source_crop_test: ok\n");
    return 0;
}
