/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "holds.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>

namespace crs {

namespace {

/* The whole of s as an unsigned number in base 0 (decimal, or hex after
 * 0x); hex_only: 0x and hex digits only. */
bool number(const std::string &s, bool hex_only, uint64_t *v)
{
    if (s.empty() || !std::isdigit((unsigned char)s[0]))
        return false;
    if (hex_only && (s.size() < 3 || s[0] != '0' || (s[1] != 'x' && s[1] != 'X') ||
                     s.find_first_not_of("0123456789abcdefABCDEF", 2) != std::string::npos))
        return false;
    char *end = nullptr;
    *v = std::strtoull(s.c_str(), &end, 0);
    return *end == '\0';
}

std::string hex(uint64_t v)
{
    char b[24];
    std::snprintf(b, sizeof b, "0x%llx", (unsigned long long)v);
    return b;
}

/* The tokens of a list separated by commas or spaces. */
std::vector<std::string> tokens(const std::string &list)
{
    std::vector<std::string> out;
    for (size_t at = 0; at < list.size();) {
        const size_t end = std::min(list.find_first_of(", \t", at), list.size());
        if (end > at)
            out.push_back(list.substr(at, end - at));
        at = end + 1;
    }
    return out;
}

}  // namespace

bool load_holds(const HoldSettings &cfg, const std::vector<uint64_t> &allowed, std::vector<TargetSpec> *targets,
                std::string *err)
{
    const std::string &on = cfg.hold;
    if (on != "0" && on != "1") {
        *err = "guide_hold must be 0 or 1, not \"" + on + "\"";
        return false;
    }
    if (on == "0")
        return true;
    if (std::none_of(targets->begin(), targets->end(), [](const TargetSpec &t) { return t.name == "map"; })) {
        *err = "guide_hold: there is no map target to follow";
        return false;
    }
    uint64_t scene = 0, klass = 0;
    if (!number(cfg.scene_id, false, &scene) || !number(cfg.content_class, false, &klass) || klass > 0xffffffffu) {
        *err = "guide_scene_id and guide_content_class must be numbers, not \"" + cfg.scene_id + "\" and \"" +
               cfg.content_class + "\"";
        return false;
    }
    std::vector<uint64_t> takes;
    for (const std::string &c : tokens(cfg.take_over)) {
        uint64_t v = 0;
        if (!number(c, true, &v) || !v) {
            *err = "guide_take_over: \"" + c + "\" is not a hex content id";
            return false;
        }
        takes.push_back(v);
    }
    if (takes.empty()) {
        *err = "guide_take_over names no content";
        return false;
    }
    std::vector<TargetSpec> holds;
    for (const std::string &id : tokens(cfg.slots)) {
        TargetSpec t;
        if (!number(id, true, &t.slot) || t.slot < 1 || t.slot > 0xfff) {
            *err = "guide_slots: \"" + id + "\" is not a slot id from 0x1 to 0xfff";
            return false;
        }
        t.name = "guide_" + hex(t.slot);
        t.content_class = (uint32_t)klass;
        t.scene_id = scene + holds.size();
        t.width = t.height = 16;
        t.linger_ms = 0;
        t.take_over_stock = true;
        t.follows = "map";
        t.take_over_contents = takes;
        for (const std::vector<TargetSpec> *v : {targets, &holds})
            for (const TargetSpec &o : *v) {
                if (o.scene_id == t.scene_id) {
                    *err = "guide_slots: " + t.name + "'s scene id " + hex(t.scene_id) + " is target " + o.name +
                           "'s";
                    return false;
                }
                if (o.slot == t.slot) {
                    *err = "guide_slots: slot " + hex(t.slot) +
                           (o.follows.empty() ? " is target " + o.name + "'s" : std::string(" is listed twice"));
                    return false;
                }
            }
        if (std::find(allowed.begin(), allowed.end(), t.scene_id) == allowed.end()) {
            *err = "guide_slots: " + t.name + "'s scene id " + hex(t.scene_id) + " is not in scene_ids_allowed";
            return false;
        }
        holds.push_back(t);
    }
    if (holds.empty()) {
        *err = "guide_hold: guide_slots names no slot";
        return false;
    }
    targets->insert(targets->end(), holds.begin(), holds.end());
    return true;
}

}  // namespace crs
