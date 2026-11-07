// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "sps_info.h"
#include "bit_reader.h"

#include <cstdio>
#include <cstring>

namespace woc {

namespace {

/* Skips n flags. */
bool flags(Bits &b, int n)
{
    uint32_t v;
    return b.u(n, &v);
}

/* scaling_list() (7.3.2.1.1.1): only its length in the bitstream matters. */
bool scaling_list(Bits &b, int size)
{
    int32_t last = 8, next = 8;
    for (int j = 0; j < size; j++) {
        if (next != 0) {
            int32_t delta;
            if (!b.se(&delta) || delta < -128 || delta > 127)
                return false;
            next = (last + delta + 256) % 256;
        }
        last = next == 0 ? last : next;
    }
    return true;
}

/* hrd_parameters() (E.1.2). */
bool hrd(Bits &b)
{
    uint32_t cpb_cnt_minus1, v;
    if (!b.ue(&cpb_cnt_minus1) || cpb_cnt_minus1 > 31 || !b.u(8, &v))
        return false;
    for (uint32_t i = 0; i <= cpb_cnt_minus1; i++)
        if (!b.ue(&v) || !b.ue(&v) || !flags(b, 1))
            return false;
    return flags(b, 20);
}

/* vui_parameters() (E.1.1) up to bitstream_restriction's two fields. */
SpsInfo::Vui vui(Bits &b, SpsInfo *out)
{
    uint32_t f, v;
    if (!b.u(1, &f))   /* aspect_ratio_info_present_flag */
        return SpsInfo::Unreadable;
    if (f) {
        if (!b.u(8, &v) || (v == 255 && !flags(b, 32)))
            return SpsInfo::Unreadable;
    }
    if (!b.u(1, &f) || (f && !flags(b, 1)))   /* overscan */
        return SpsInfo::Unreadable;
    if (!b.u(1, &f))   /* video_signal_type_present_flag */
        return SpsInfo::Unreadable;
    if (f) {
        if (!flags(b, 4) || !b.u(1, &v) || (v && !flags(b, 24)))
            return SpsInfo::Unreadable;
    }
    if (!b.u(1, &f) || (f && (!b.ue(&v) || !b.ue(&v))))   /* chroma_loc_info */
        return SpsInfo::Unreadable;
    /* timing_info: num_units_in_tick, time_scale, fixed_frame_rate_flag */
    if (!b.u(1, &f) || (f && (!flags(b, 32) || !flags(b, 32) || !flags(b, 1))))
        return SpsInfo::Unreadable;
    uint32_t nal_hrd, vcl_hrd;
    if (!b.u(1, &nal_hrd) || (nal_hrd && !hrd(b)) || !b.u(1, &vcl_hrd) || (vcl_hrd && !hrd(b)))
        return SpsInfo::Unreadable;
    if ((nal_hrd || vcl_hrd) && !flags(b, 1))   /* low_delay_hrd_flag */
        return SpsInfo::Unreadable;
    if (!flags(b, 1) || !b.u(1, &f))   /* pic_struct_present_flag, bitstream_restriction_flag */
        return SpsInfo::Unreadable;
    if (!f)
        return SpsInfo::NoRestriction;
    /* motion_vectors_over_pic_boundaries_flag, max_bytes_per_pic_denom,
     * max_bits_per_mb_denom, log2_max_mv_length_horizontal and _vertical */
    if (!flags(b, 1) || !b.ue(&v) || !b.ue(&v) || !b.ue(&v) || !b.ue(&v))
        return SpsInfo::Unreadable;
    uint32_t reorder, buffering;
    if (!b.ue(&reorder) || !b.ue(&buffering) || reorder > 16 || buffering > 16)
        return SpsInfo::Unreadable;
    out->max_num_reorder_frames = reorder;
    out->max_dec_frame_buffering = buffering;
    return SpsInfo::Restriction;
}

bool high_profile(uint32_t p)
{
    switch (p) {
    case 100: case 110: case 122: case 244: case 44: case 83: case 86: case 118: case 128: case 138: case 139:
    case 134: case 135:
        return true;
    }
    return false;
}

const char *profile_name(uint32_t p, uint32_t constraint_flags)
{
    switch (p) {
    case 66: return constraint_flags & 0x40 ? "Constrained Baseline" : "Baseline";
    case 77: return "Main";
    case 88: return "Extended";
    case 100: return "High";
    case 110: return "High 10";
    case 122: return "High 4:2:2";
    case 244: return "High 4:4:4 Predictive";
    }
    return nullptr;
}

}  // namespace

bool parse_sps(const uint8_t *nal, size_t len, SpsInfo *out)
{
    *out = SpsInfo();
    if (len < 4 || (nal[0] & 0x1f) != 7)
        return false;
    Bits b(nal + 1, len - 1);
    SpsInfo s;
    uint32_t v;
    if (!b.u(8, &s.profile_idc) || !b.u(8, &s.constraint_flags) || !b.u(8, &s.level_idc) || !b.ue(&v) || v > 31)
        return false;
    uint32_t chroma_format_idc = 1, separate_planes = 0;
    if (high_profile(s.profile_idc)) {
        if (!b.ue(&chroma_format_idc) || chroma_format_idc > 3)
            return false;
        if (chroma_format_idc == 3 && !b.u(1, &separate_planes))
            return false;
        uint32_t scaling;
        /* bit_depth_luma_minus8, bit_depth_chroma_minus8,
         * qpprime_y_zero_transform_bypass_flag, seq_scaling_matrix_present_flag */
        if (!b.ue(&v) || !b.ue(&v) || !flags(b, 1) || !b.u(1, &scaling))
            return false;
        if (scaling) {
            for (int i = 0; i < (chroma_format_idc != 3 ? 8 : 12); i++) {
                uint32_t present;
                if (!b.u(1, &present) || (present && !scaling_list(b, i < 6 ? 16 : 64)))
                    return false;
            }
        }
    }
    if (!b.ue(&v) || v > 12 || !b.ue(&s.poc_type) || s.poc_type > 2)   /* log2_max_frame_num_minus4 */
        return false;
    if (s.poc_type == 0) {
        if (!b.ue(&v) || v > 12)   /* log2_max_pic_order_cnt_lsb_minus4 */
            return false;
    } else if (s.poc_type == 1) {
        int32_t offset;
        uint32_t cycle;
        if (!flags(b, 1) || !b.se(&offset) || !b.se(&offset) || !b.ue(&cycle) || cycle > 255)
            return false;
        for (uint32_t i = 0; i < cycle; i++)
            if (!b.se(&offset))
                return false;
    }
    uint32_t mbs_w, map_h, frame_mbs_only;
    /* max_num_ref_frames, gaps_in_frame_num_value_allowed_flag */
    if (!b.ue(&v) || !flags(b, 1) || !b.ue(&mbs_w) || !b.ue(&map_h) || !b.u(1, &frame_mbs_only))
        return false;
    if (mbs_w > 1023 || map_h > 1023)
        return false;
    /* mb_adaptive_frame_field_flag, direct_8x8_inference_flag */
    uint32_t cropping;
    if ((!frame_mbs_only && !flags(b, 1)) || !flags(b, 1) || !b.u(1, &cropping))
        return false;
    uint64_t w = (uint64_t)(mbs_w + 1) * 16, h = (uint64_t)(map_h + 1) * 16 * (2 - frame_mbs_only);
    if (cropping) {
        uint32_t left, right, top, bottom;
        if (!b.ue(&left) || !b.ue(&right) || !b.ue(&top) || !b.ue(&bottom))
            return false;
        const uint32_t chroma = separate_planes ? 0 : chroma_format_idc;
        const uint64_t unit_x = chroma == 1 || chroma == 2 ? 2 : 1;
        const uint64_t unit_y = (chroma == 1 ? 2 : 1) * (2 - frame_mbs_only);
        const uint64_t cut_x = unit_x * ((uint64_t)left + right), cut_y = unit_y * ((uint64_t)top + bottom);
        if (cut_x >= w || cut_y >= h)
            return false;
        w -= cut_x;
        h -= cut_y;
    }
    s.width = (uint32_t)w;
    s.height = (uint32_t)h;
    uint32_t has_vui;
    if (!b.u(1, &has_vui))
        return false;
    s.vui = has_vui ? vui(b, &s) : SpsInfo::NoVui;
    *out = s;
    return true;
}

std::string describe_sps(const SpsInfo &s)
{
    char restriction[96];
    switch (s.vui) {
    case SpsInfo::NoVui:
        std::snprintf(restriction, sizeof restriction, "none (no VUI)");
        break;
    case SpsInfo::NoRestriction:
        std::snprintf(restriction, sizeof restriction, "none");
        break;
    case SpsInfo::Restriction:
        std::snprintf(restriction, sizeof restriction, "max_num_reorder_frames %u max_dec_frame_buffering %u",
                      s.max_num_reorder_frames, s.max_dec_frame_buffering);
        break;
    case SpsInfo::Unreadable:
        std::snprintf(restriction, sizeof restriction, "unknown (VUI unreadable)");
        break;
    }
    char profile[64];
    const char *name = profile_name(s.profile_idc, s.constraint_flags);
    if (name)
        std::snprintf(profile, sizeof profile, "%s (profile_idc %u)", name, s.profile_idc);
    else
        std::snprintf(profile, sizeof profile, "profile_idc %u", s.profile_idc);
    char line[256];
    std::snprintf(line, sizeof line, "%s level %u.%u, %ux%u, pic_order_cnt_type %u, bitstream_restriction %s", profile,
                  s.level_idc / 10, s.level_idc % 10, s.width, s.height, s.poc_type, restriction);
    return line;
}

std::string SpsLog::sps(const uint8_t *nal, size_t len, const char *source, int64_t now_ms)
{
    const bool same = source_ && std::strcmp(source, source_) == 0 && bytes_.size() == len &&
                      std::memcmp(bytes_.data(), nal, len) == 0;
    const bool recent = seen_ms_ >= 0 && now_ms - seen_ms_ < kRepeatMs;
    seen_ms_ = now_ms;
    if (same && recent)
        return "";
    if (!same) {
        bytes_.assign(nal, nal + len);
        source_ = source;
        SpsInfo info;
        char head[64];
        std::snprintf(head, sizeof head, "%s: ", source);
        if (parse_sps(nal, len, &info)) {
            last_ = head + describe_sps(info);
        } else {
            std::snprintf(head, sizeof head, "%s: unreadable (%zu bytes)", source, len);
            last_ = head;
        }
    }
    return "waze: SPS from " + last_;
}

}  // namespace woc
