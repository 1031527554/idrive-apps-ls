// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The "Map layout" the app chooses (README.md "Where the map shows"): the
 * form of the cluster's map, one choice for all of it, named once here so the
 * configuration's own target/rect (main.cpp), the control command
 * (MapFeeds::set_layout) and the state file's key (map_state.cpp) all agree.
 *
 * central: the native central-map slot `map` (the 1088x480 scene the map
 * fills), no rect. wide: the whole panel, the map stretched into
 * 0,0,1632,720 (1.5x the 1088x480 map, so the picture's shape is kept, and
 * the panel's right 288 px are left to the gauges). full: the same target
 * stretched into the whole 0,0,1920,720, over the gauges. The map is
 * stretched to the rect whatever its shape (map_rect.h). wide and full share
 * the HUD's scene id 0x01000400, so the HUD's map is off while either is in
 * effect (map_feeds.cpp). */
#ifndef WOC_MAP_LAYOUT_H
#define WOC_MAP_LAYOUT_H

#include <string>

#include "map_rect.h"

namespace woc {

/* The cluster target and rect a layout names. False for any other value,
 * which leaves what the value cannot name alone. */
inline bool layout_target_rect(const std::string &value, std::string *target, MapRect *rect)
{
    if (value == "central") {
        *target = "map";
        *rect = MapRect();
    } else if (value == "wide") {
        *target = "panel";
        rect->x = 0;
        rect->y = 0;
        rect->w = 1632;   /* 1.5x the 1088x480 map; the gauges get the rest */
        rect->h = 720;
    } else if (value == "full") {
        *target = "panel";
        rect->x = 0;
        rect->y = 0;
        rect->w = 1920;
        rect->h = 720;
    } else {
        return false;
    }
    return true;
}

/* Whether value names a layout (any layout_target_rect takes). */
inline bool layout_known(const std::string &value)
{
    std::string target;
    MapRect rect;
    return layout_target_rect(value, &target, &rect);
}

}  // namespace woc

#endif
