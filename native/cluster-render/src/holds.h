/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The guide hold's settings (cluster-render.conf "guide hold", iDrive 7):
 * with guide_hold = 1, a hold (slots.h) per slot of guide_slots that
 * follows the map, appended to the targets. */
#ifndef CRS_HOLDS_H
#define CRS_HOLDS_H

#include <stdint.h>
#include <string>
#include <vector>

#include "slots.h"

namespace crs {

/* The settings as written. */
struct HoldSettings {
    std::string hold, slots, scene_id, content_class;   /* guide_hold, guide_slots, ... */
};

/* hold: 0 or 1. slots: hex slot ids 0x1-0xfff, separated by commas or
 * spaces, each once and no other target's. Scene ids from scene_id up, one
 * per slot, each in allowed and no other target's. False, with err, on anything else; targets is
 * then left as it was. */
bool load_holds(const HoldSettings &cfg, const std::vector<uint64_t> &allowed, std::vector<TargetSpec> *targets,
                std::string *err);

}  // namespace crs

#endif
