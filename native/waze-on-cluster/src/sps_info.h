// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* What a stream's sequence parameter set says about its frame order, for
 * the log and probe.txt: profile and level, picture size,
 * pic_order_cnt_type, and the VUI's bitstream_restriction
 * (max_num_reorder_frames, max_dec_frame_buffering), which bounds how many
 * frames a decoder holds before it outputs one in display order. An SPS
 * without it lets a decoder hold up to its whole DPB.
 *
 * Read from the SPS RBSP (ITU-T H.264 7.3.2.1.1, E.1.1) with every read
 * bounds-checked. */
#ifndef WOC_SPS_INFO_H
#define WOC_SPS_INFO_H

#include <stddef.h>
#include <stdint.h>
#include <string>
#include <vector>

namespace woc {

struct SpsInfo {
    uint32_t profile_idc = 0, constraint_flags = 0, level_idc = 0;
    uint32_t width = 0, height = 0;   /* the picture after the SPS's cropping */
    uint32_t poc_type = 0;            /* pic_order_cnt_type */
    enum Vui {
        NoVui,           /* vui_parameters_present_flag 0 */
        NoRestriction,   /* VUI without bitstream_restriction */
        Restriction,     /* the two fields below are set */
        Unreadable,      /* VUI present but cut short or out of range */
    } vui = NoVui;
    uint32_t max_num_reorder_frames = 0, max_dec_frame_buffering = 0;
};

/* One SPS NAL unit, from its header byte, without a start code. False when
 * it is not an SPS, or it ends or goes out of range before
 * vui_parameters_present_flag; a VUI that does so is Unreadable. */
bool parse_sps(const uint8_t *nal, size_t len, SpsInfo *out);

/* "High (profile_idc 100) level 4.2, 1920x900, pic_order_cnt_type 0,
 * bitstream_restriction max_num_reorder_frames 0 max_dec_frame_buffering 1" */
std::string describe_sps(const SpsInfo &sps);

/* Each sequence's SPS, once: the same SPS from the same source within
 * kRepeatMs of the last one is the same sequence. Not thread-safe. */
class SpsLog {
public:
    static const int64_t kRepeatMs = 60000;

    /* An SPS NAL unit (as parse_sps takes it) from source at now_ms. The
     * line to log, or empty. Allocates only when the SPS differs from the
     * last. */
    std::string sps(const uint8_t *nal, size_t len, const char *source, int64_t now_ms);
    /* The last SPS's description and source; empty before the first. */
    const std::string &last() const { return last_; }

private:
    std::vector<uint8_t> bytes_;
    const char *source_ = nullptr;
    int64_t seen_ms_ = -1;
    std::string last_;
};

}  // namespace woc

#endif
