// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host tests for the SPS fields the log reports (sps_info.h).
 *
 * The golden test reads the SPS of test/data/stream15_start.rtp (its 4th
 * packet, a single NAL unit), the phone's 1920x900 High@4.2 stream, whose
 * fields ffmpeg's trace_headers reads as: pic_order_cnt_type 0, a VUI with
 * bitstream_restriction, max_num_reorder_frames 0, max_dec_frame_buffering 4.
 * Synthetic SPSs, written with emulation prevention, cover the other
 * branches: no VUI, a VUI without bitstream_restriction, one with timing,
 * HRD and the restriction, a scaling matrix, pic_order_cnt_type 1 and 2,
 * cropping, field coding. Every prefix of each is read without going past
 * its end (a guard page follows it) and gives the whole SPS's fields or is
 * refused; malformed input is refused. */
#include "../src/sps_info.h"

#include <sys/mman.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace woc;

static int failures;

#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

typedef std::vector<uint8_t> Bytes;

/* Writes RBSP bits, then the NAL unit with emulation prevention bytes. */
struct Writer {
    std::vector<int> bits;
    void u(int n, uint32_t v) { for (int i = n - 1; i >= 0; i--) bits.push_back((v >> i) & 1); }
    void ue(uint32_t v)
    {
        const uint64_t x = (uint64_t)v + 1;
        int n = 0;
        while ((x >> (n + 1)) != 0) n++;
        u(n, 0);
        for (int i = n; i >= 0; i--) bits.push_back((int)((x >> i) & 1));
    }
    void se(int32_t v) { ue(v > 0 ? (uint32_t)(2 * v - 1) : (uint32_t)(-2 * v)); }
    Bytes nal(uint8_t header = 0x67) const
    {
        std::vector<int> b = bits;
        b.push_back(1);   /* rbsp_stop_one_bit */
        while (b.size() % 8) b.push_back(0);
        Bytes rbsp;
        for (size_t i = 0; i < b.size(); i += 8) {
            uint8_t v = 0;
            for (int j = 0; j < 8; j++) v = (uint8_t)(v << 1 | b[i + j]);
            rbsp.push_back(v);
        }
        Bytes out = {header};
        int zeros = 0;
        for (uint8_t v : rbsp) {
            if (zeros >= 2 && v <= 3) { out.push_back(3); zeros = 0; }
            out.push_back(v);
            zeros = v == 0 ? zeros + 1 : 0;
        }
        return out;
    }
};

struct Spec {
    uint32_t profile = 100, constraint = 0, level = 31;
    bool scaling = false;
    uint32_t poc_type = 0;
    uint32_t mbs_w = 79, map_h = 44;   /* 1280x720 */
    bool frame_mbs_only = true;
    uint32_t crop_bottom = 0;
    int vui = 0;                       /* 0 none, 1 without restriction, 2 with it */
    bool timing_hrd = false;
    uint32_t reorder = 2, buffering = 4;
};

static Bytes sps(const Spec &s)
{
    Writer w;
    w.u(8, s.profile);
    w.u(8, s.constraint);
    w.u(8, s.level);
    w.ue(0);                       /* seq_parameter_set_id */
    if (s.profile == 100) {
        w.ue(1);                   /* chroma_format_idc 4:2:0 */
        w.ue(0); w.ue(0);          /* bit depths */
        w.u(1, 0);                 /* qpprime_y_zero_transform_bypass_flag */
        w.u(1, s.scaling);
        if (s.scaling) {
            for (int i = 0; i < 8; i++) {
                const bool present = i == 0 || i == 6;
                w.u(1, present);
                if (present)
                    for (int j = 0; j < (i < 6 ? 16 : 64); j++)
                        w.se(j == 0 ? 8 : j % 3 - 1);
            }
        }
    }
    w.ue(4);                       /* log2_max_frame_num_minus4 */
    w.ue(s.poc_type);
    if (s.poc_type == 0) {
        w.ue(4);
    } else if (s.poc_type == 1) {
        w.u(1, 0);
        w.se(-2); w.se(1);
        w.ue(3);
        w.se(2); w.se(-1); w.se(0);
    }
    w.ue(3);                       /* max_num_ref_frames */
    w.u(1, 0);
    w.ue(s.mbs_w);
    w.ue(s.map_h);
    w.u(1, s.frame_mbs_only);
    if (!s.frame_mbs_only)
        w.u(1, 0);
    w.u(1, 1);                     /* direct_8x8_inference_flag */
    w.u(1, s.crop_bottom != 0);
    if (s.crop_bottom) { w.ue(0); w.ue(0); w.ue(0); w.ue(s.crop_bottom); }
    w.u(1, s.vui != 0);
    if (s.vui) {
        w.u(1, 1); w.u(8, 255); w.u(16, 1); w.u(16, 1);   /* aspect ratio, extended SAR */
        w.u(1, 1); w.u(1, 0);                             /* overscan */
        w.u(1, 1); w.u(3, 5); w.u(1, 0); w.u(1, 1); w.u(8, 1); w.u(8, 1); w.u(8, 1);
        w.u(1, 1); w.ue(0); w.ue(0);                      /* chroma_loc_info */
        w.u(1, s.timing_hrd);
        if (s.timing_hrd) { w.u(32, 1); w.u(32, 60); w.u(1, 1); }
        w.u(1, s.timing_hrd);                             /* nal_hrd */
        if (s.timing_hrd) {
            w.ue(1); w.u(4, 0); w.u(4, 0);
            for (int i = 0; i < 2; i++) { w.ue(1000); w.ue(2000); w.u(1, 0); }
            w.u(5, 23); w.u(5, 23); w.u(5, 23); w.u(5, 24);
        }
        w.u(1, 0);                                        /* vcl_hrd */
        if (s.timing_hrd) w.u(1, 0);                      /* low_delay_hrd_flag */
        w.u(1, 0);                                        /* pic_struct_present_flag */
        w.u(1, s.vui == 2);
        if (s.vui == 2) {
            w.u(1, 1); w.ue(2); w.ue(1); w.ue(16); w.ue(16);
            w.ue(s.reorder);
            w.ue(s.buffering);
        }
    }
    return w.nal();
}

/* Every prefix of a valid SPS up to the whole, its last byte the last one before a page
 * the process cannot read, so that a read past its end crashes the test.
 * The shortest are refused; once a prefix reads, every longer one does,
 * with the whole SPS's fields, and a VUI that is the whole one's or, cut
 * short, Unreadable. An SPS with a VUI has prefixes that cut it short. */
static void prefixes(const Bytes &nal)
{
    SpsInfo whole;
    CHECK(parse_sps(nal.data(), nal.size(), &whole));
    const size_t page = (size_t)sysconf(_SC_PAGESIZE);
    void *map = mmap(nullptr, 2 * page, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(map != MAP_FAILED);
    if (map == MAP_FAILED)
        return;
    uint8_t *mem = static_cast<uint8_t *>(map);
    CHECK(mprotect(mem + page, page, PROT_NONE) == 0);
    bool read = false, cut_vui = false;   /* a shorter prefix read; one cut the VUI short */
    for (size_t n = 0; n <= nal.size(); n++) {
        uint8_t *cut = mem + page - n;
        std::memcpy(cut, nal.data(), n);
        SpsInfo s;
        const bool ok = parse_sps(cut, n, &s);
        CHECK(n > 0 || !ok);
        CHECK(ok || !read);
        read = read || ok;
        if (!ok)
            continue;
        CHECK(s.profile_idc == whole.profile_idc && s.level_idc == whole.level_idc);
        CHECK(s.width == whole.width && s.height == whole.height && s.poc_type == whole.poc_type);
        CHECK(s.vui == whole.vui || s.vui == SpsInfo::Unreadable);
        if (s.vui == SpsInfo::Restriction)
            CHECK(s.max_num_reorder_frames == whole.max_num_reorder_frames &&
                  s.max_dec_frame_buffering == whole.max_dec_frame_buffering);
        cut_vui = cut_vui || s.vui == SpsInfo::Unreadable;
    }
    CHECK(cut_vui == (whole.vui != SpsInfo::NoVui));
    munmap(map, 2 * page);
}

static void golden()
{
    const Bytes nal = {0x27, 0x64, 0x00, 0x2a, 0xac, 0x13, 0x14, 0x50, 0x1e, 0x01, 0xcf, 0xe7, 0x9b,
                       0x80, 0x86, 0x83, 0x03, 0x68, 0x22, 0x11, 0x96};
    SpsInfo s;
    CHECK(parse_sps(nal.data(), nal.size(), &s));
    CHECK(s.profile_idc == 100 && s.level_idc == 42);
    CHECK(s.width == 1920 && s.height == 900);
    CHECK(s.poc_type == 0);
    CHECK(s.vui == SpsInfo::Restriction);
    CHECK(s.max_num_reorder_frames == 0 && s.max_dec_frame_buffering == 4);
    CHECK(describe_sps(s) == "High (profile_idc 100) level 4.2, 1920x900, pic_order_cnt_type 0, "
                             "bitstream_restriction max_num_reorder_frames 0 max_dec_frame_buffering 4");
    prefixes(nal);
}

static void synthetic()
{
    {
        Spec sp;
        sp.vui = 2;
        sp.crop_bottom = 4;   /* 1280x728 cropped by 8 rows */
        sp.map_h = 45;
        const Bytes nal = sps(sp);
        SpsInfo s;
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(s.width == 1280 && s.height == 728);
        CHECK(s.vui == SpsInfo::Restriction && s.max_num_reorder_frames == 2 && s.max_dec_frame_buffering == 4);
        prefixes(nal);
    }
    {
        Spec sp;
        sp.profile = 66;
        sp.constraint = 0xc0;
        sp.level = 31;
        sp.poc_type = 2;
        const Bytes nal = sps(sp);
        SpsInfo s;
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(s.width == 1280 && s.height == 720 && s.poc_type == 2 && s.vui == SpsInfo::NoVui);
        CHECK(describe_sps(s) == "Constrained Baseline (profile_idc 66) level 3.1, 1280x720, pic_order_cnt_type 2, "
                                 "bitstream_restriction none (no VUI)");
        prefixes(nal);
    }
    {
        Spec sp;
        sp.profile = 77;
        sp.vui = 1;
        sp.poc_type = 1;
        const Bytes nal = sps(sp);
        SpsInfo s;
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(s.poc_type == 1 && s.vui == SpsInfo::NoRestriction);
        CHECK(describe_sps(s) == "Main (profile_idc 77) level 3.1, 1280x720, pic_order_cnt_type 1, "
                                 "bitstream_restriction none");
        prefixes(nal);
    }
    {
        Spec sp;
        sp.vui = 2;
        sp.timing_hrd = true;
        sp.scaling = true;
        sp.reorder = 1;
        sp.buffering = 3;
        const Bytes nal = sps(sp);
        SpsInfo s;
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(s.vui == SpsInfo::Restriction && s.max_num_reorder_frames == 1 && s.max_dec_frame_buffering == 3);
        prefixes(nal);
    }
    {
        Spec sp;
        sp.frame_mbs_only = false;   /* map units of two macroblock rows */
        sp.map_h = 22;
        sp.crop_bottom = 2;          /* 4 rows a unit */
        const Bytes nal = sps(sp);
        SpsInfo s;
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(s.width == 1280 && s.height == 728);
    }
    {
        /* An unknown profile is named by its number. */
        Spec sp;
        sp.profile = 99;
        const Bytes nal = sps(sp);
        SpsInfo s;
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(describe_sps(s).compare(0, 25, "profile_idc 99 level 3.1,") == 0);
    }
}

static void malformed()
{
    SpsInfo s;
    CHECK(!parse_sps(nullptr, 0, &s));
    const Bytes pps = {0x68, 0xee, 0x3c, 0xb0};
    CHECK(!parse_sps(pps.data(), pps.size(), &s));
    const Bytes ff(32, 0xff);   /* type 31 */
    CHECK(!parse_sps(ff.data(), ff.size(), &s));
    Bytes ones(32, 0xff);
    ones[0] = 0x67;             /* every ue(v) 0 and every flag set: read up to its end, no further */
    CHECK(parse_sps(ones.data(), ones.size(), &s) && s.width == 16 && s.height == 16);
    Bytes zeros(32, 0x00);
    zeros[0] = 0x67;            /* an ue(v) of more than 31 leading zeros */
    CHECK(!parse_sps(zeros.data(), zeros.size(), &s));
    {
        Spec sp;
        sp.crop_bottom = 400;   /* crops more than the picture */
        const Bytes nal = sps(sp);
        CHECK(!parse_sps(nal.data(), nal.size(), &s));
    }
    {
        Spec sp;
        sp.vui = 2;
        sp.reorder = 40;        /* more than any DPB */
        const Bytes nal = sps(sp);
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(s.vui == SpsInfo::Unreadable && s.width == 1280);
        CHECK(describe_sps(s).find("bitstream_restriction unknown (VUI unreadable)") != std::string::npos);
    }
    {
        /* The VUI cut short: the SPS fields still read. */
        Spec sp;
        sp.vui = 2;
        Bytes nal = sps(sp);
        nal.resize(nal.size() - 3);
        CHECK(parse_sps(nal.data(), nal.size(), &s));
        CHECK(s.vui == SpsInfo::Unreadable && s.width == 1280 && s.height == 720);
    }
}

static void log_lines()
{
    Spec a;
    a.vui = 2;
    const Bytes sa = sps(a);
    Spec b;
    b.profile = 66;
    const Bytes sb = sps(b);
    SpsLog log;
    CHECK(log.last().empty());
    const std::string first = log.sps(sa.data(), sa.size(), "avb", 1000);
    CHECK(first == "waze: SPS from avb: High (profile_idc 100) level 3.1, 1280x720, pic_order_cnt_type 0, "
                   "bitstream_restriction max_num_reorder_frames 2 max_dec_frame_buffering 4");
    CHECK(log.last() == first.substr(15));
    /* the stream's second keyframe, and one every few seconds after it */
    CHECK(log.sps(sa.data(), sa.size(), "avb", 1500).empty());
    CHECK(log.sps(sa.data(), sa.size(), "avb", 50000).empty());
    CHECK(log.sps(sa.data(), sa.size(), "avb", 100000).empty());
    /* the same SPS after a pause: a new stream */
    CHECK(log.sps(sa.data(), sa.size(), "avb", 100000 + SpsLog::kRepeatMs) == first);
    /* another source or another SPS */
    CHECK(log.sps(sa.data(), sa.size(), "udp", 100001).find("waze: SPS from udp: High") == 0);
    CHECK(log.sps(sb.data(), sb.size(), "udp", 100002).find("waze: SPS from udp: Baseline (profile_idc 66)") == 0);
    CHECK(log.sps(sa.data(), sa.size(), "udp", 100003).find("waze: SPS from udp: High") == 0);
    const Bytes bad = {0x67, 0x64};
    CHECK(log.sps(bad.data(), bad.size(), "fifo", 100004) == "waze: SPS from fifo: unreadable (2 bytes)");
    CHECK(log.last() == "fifo: unreadable (2 bytes)");
}

int main()
{
    golden();
    synthetic();
    malformed();
    log_lines();
    if (failures) {
        std::printf("sps_info_test: %d FAILED\n", failures);
        return 1;
    }
    std::printf("sps_info_test: all passed\n");
    return 0;
}
