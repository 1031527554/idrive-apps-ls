// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
/* The part of a decoded picture that becomes the map: `src_crop` in the
 * conf, "SWxSH:X,Y,W,H". It applies only to a sequence of exactly SW x SH, so
 * one setting can serve a phone that pads its picture (Android Auto's cluster
 * display: its UI in a corner of a 1920x1080 frame) without touching a stream
 * of another size (CarPlay's, already the map's own size). Empty: the whole
 * picture. Every number is even (4:2:0), the rect lies inside the sequence and
 * is at least 16x16. */
#ifndef WOC_SOURCE_CROP_H
#define WOC_SOURCE_CROP_H

#include <stdint.h>
#include <stdio.h>
#include <string>

namespace woc {

struct SourceCrop {
    uint32_t seq_w = 0, seq_h = 0;   /* 0: no crop */
    uint32_t x = 0, y = 0, w = 0, h = 0;

    bool enabled() const { return seq_w != 0; }
    bool applies(uint32_t sw, uint32_t sh) const { return enabled() && sw == seq_w && sh == seq_h; }
};

/* Parses `text` into *out. Returns null, or why it cannot be used. */
inline const char *parse_source_crop(const std::string &text, SourceCrop *out)
{
    *out = SourceCrop();
    if (text.empty())
        return nullptr;
    unsigned sw, sh, x, y, w, h;
    char tail;
    if (sscanf(text.c_str(), "%ux%u:%u,%u,%u,%u%c", &sw, &sh, &x, &y, &w, &h, &tail) != 6)
        return "must be SWxSH:X,Y,W,H, or empty";
    if (sw == 0 || sh == 0 || sw > 4096 || sh > 4096)
        return "the sequence size must be from 1x1 to 4096x4096";
    if ((sw | sh | x | y | w | h) & 1)
        return "every number must be even (4:2:0)";
    if (w < 16 || h < 16)
        return "the rect must be at least 16x16";
    if ((uint64_t)x + w > sw || (uint64_t)y + h > sh)
        return "the rect must lie inside the sequence";
    out->seq_w = sw;
    out->seq_h = sh;
    out->x = x;
    out->y = y;
    out->w = w;
    out->h = h;
    return nullptr;
}

}  // namespace woc

#endif
