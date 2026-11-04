// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A stand-in for the unit's MSDK and libva, for decoder_msdk.cpp on the host.
 *
 * Its stream is not H.264 past the NAL headers: an SPS (type 7) carries its
 * picture size as text, "1280x720"; a PPS (8) is required next to it; a
 * slice (1 or 5) carries, after its first byte, one byte that is the
 * picture's content. A picture decodes to every luma and chroma byte equal
 * to that content. An SPS larger than the surfaces the decoder was set up
 * for is incompatible (MFX_ERR_INCOMPATIBLE_VIDEO_PARAM); a smaller one
 * changes the pictures' size in the running sequence.
 *
 * Every call that matters goes to `calls`, in order:
 *   "header WxH"        DecodeHeader read an SPS
 *   "init WxH"          the decoder set up for a sequence
 *   "vpp-init X,Y,W,H"  VPP set up for an input rect
 *   "decode-sync"       SyncOperation on a decode task
 *   "vpp X,Y,W,H"       VPP run on a picture with this input rect
 *   "vpp-sync"          SyncOperation on a VPP task */
#ifndef WOC_FAKE_MSDK_H
#define WOC_FAKE_MSDK_H

#include <stdint.h>
#include <string>
#include <vector>

namespace fake_msdk {

extern std::vector<std::string> calls;

/* An access unit of the fake stream: the SPS and PPS when sps is a size
 * ("1088x480"), then an IDR slice (idr) or a P slice whose picture is
 * content (1-127). */
std::string access_unit(const char *sps, bool idr, uint8_t content);

/* How many entries of calls equal s. */
int count(const std::string &s);

}  // namespace fake_msdk

#endif
