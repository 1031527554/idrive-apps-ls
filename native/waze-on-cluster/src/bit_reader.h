// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Bit reader over an H.264 NAL unit's payload: u(n), ue(v) and se(v)
 * (ITU-T H.264 7.2, 9.1), past emulation prevention bytes (a 03 after two
 * zero bytes, 7.4.1). Every read fails at the end of the data: bit() returns
 * -1, the others false. */
#ifndef WOC_BIT_READER_H
#define WOC_BIT_READER_H

#include <stddef.h>
#include <stdint.h>

namespace woc {

struct Bits {
    const uint8_t *p, *end;
    int zeros = 0;      /* zero bytes just read */
    unsigned byte = 0;
    int left = 0;       /* unread bits of `byte` */

    Bits(const uint8_t *data, size_t len) : p(data), end(data + len) {}

    int bit()
    {
        if (left == 0) {
            if (p < end && zeros >= 2 && *p == 3) {
                p++;
                zeros = 0;
            }
            if (p >= end)
                return -1;
            byte = *p++;
            zeros = byte == 0 ? zeros + 1 : 0;
            left = 8;
        }
        return (byte >> --left) & 1;
    }

    /* n bits, most significant first; false for n over 32. */
    bool u(int n, uint32_t *v)
    {
        if (n > 32)
            return false;
        uint32_t x = 0;
        for (int i = 0; i < n; i++) {
            const int b = bit();
            if (b < 0)
                return false;
            x = x << 1 | (unsigned)b;
        }
        *v = x;
        return true;
    }

    bool ue(uint32_t *v)
    {
        int n = 0, b;
        while ((b = bit()) == 0)
            if (++n > 31)
                return false;
        if (b < 0)
            return false;
        uint64_t x = 0;
        for (int i = 0; i < n; i++) {
            if ((b = bit()) < 0)
                return false;
            x = x << 1 | (unsigned)b;
        }
        *v = (uint32_t)((1ull << n) - 1 + x);
        return true;
    }

    bool se(int32_t *v)
    {
        uint32_t k;
        if (!ue(&k))
            return false;
        *v = k & 1 ? (int32_t)((k >> 1) + 1) : -(int32_t)(k >> 1);
        return true;
    }
};

}  // namespace woc

#endif
