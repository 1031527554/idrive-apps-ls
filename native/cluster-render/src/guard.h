/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The mapping guard (README.md "Mapping guard"): a mapping the cluster
 * cannot take can make the KOMBI restart the cluster and the HUD, and the
 * service would map it again after every restart and every boot.
 *
 * A mapping is a target's (slot, scene id, content class). The slot manager
 * calls strike() when the display service goes away within kWindowMs of one
 * of its mappings (slots.h). At a target's strike_limit strikes the mapping
 * is disabled: never asked for again until cluster-render's version changes
 * or reset(). A strike_limit of 0 only counts and logs the strikes. A strike
 * stops counting kExpireS after it, or once kCleanBoots boots have passed
 * without another against the same mapping; a disabled mapping keeps its
 * strikes.
 *
 * The strikes and the disabled mappings are kept in a file, written whole
 * and renamed into place at each change, so a boot never asks for a
 * disabled mapping. A file of another version is started over, and so is
 * one that cannot be read, with a warning; a file that cannot be written
 * leaves the guard working from memory, with a warning. */
#ifndef CRS_GUARD_H
#define CRS_GUARD_H

#include <stdint.h>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "slots.h"

namespace crs {

class Guard {
public:
    static const int64_t kWindowMs = 10000;
    static const int64_t kExpireS = 24 * 3600;
    static const int kCleanBoots = 3;

    /* Wall-clock seconds, for the strikes' age. */
    std::function<int64_t()> clock;

    Guard();
    /* boot_id: this boot's (a new one counts a boot for kCleanBoots). */
    void load(const std::string &path, const std::string &version, const std::string &boot_id);
    bool disabled(const TargetSpec &t) const;
    /* One strike against t's mapping, after = what came within the window;
     * true when it disables the mapping. */
    bool strike(const TargetSpec &t, const std::string &after);
    void reset();
    /* "guard: <mapping>: disabled, 2 strikes" lines; empty without strikes. */
    std::string status_text() const;

private:
    struct Mapping {
        std::vector<int64_t> strikes;   /* wall-clock seconds */
        int clean_boots = 0;
        bool disabled = false;
    };
    static std::string key(const TargetSpec &t);
    void expire();
    void save() const;

    std::string path_, version_, boot_;
    std::map<std::string, Mapping> m_;
};

}  // namespace crs

#endif
