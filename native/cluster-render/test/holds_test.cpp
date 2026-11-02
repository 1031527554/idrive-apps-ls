/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the guide hold's settings (holds.h): off by default and with
 * 0; with 1, one hold per slot of guide_slots following the map, scene ids
 * from guide_scene_id up; separators commas or spaces; every malformed value
 * refused with what was wrong and no target added: guide_hold other than 0
 * or 1, a slot that is not whole hex from 0x1 to 0xfff, a slot listed twice
 * or another target's, a scene id not allowed or another target's, a
 * take-over content that is not whole hex, none, no map, no slot. */
#include <cstdio>
#include <string>
#include <vector>

#include "../src/holds.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const std::vector<uint64_t> kAllowed = {0x010004f0, 0x010004f1, 0x010004f2};

/* The targets with the map, after load_holds with the given settings over
 * the shipped defaults (key=value). */
static bool load(const std::vector<std::string> &pairs, std::vector<TargetSpec> *t, std::string *err)
{
    HoldSettings h{"0", "0x105", "0x010004f1", "0", "0x01000310"};
    for (const std::string &p : pairs) {
        const std::string k = p.substr(0, p.find('=')), v = p.substr(p.find('=') + 1);
        (k == "guide_hold"       ? h.hold
         : k == "guide_slots"    ? h.slots
         : k == "guide_scene_id" ? h.scene_id
         : k == "guide_take_over" ? h.take_over
                                  : h.content_class) = v;
    }
    TargetSpec map;
    map.name = "map";
    map.slot = 0x100;
    map.scene_id = 0x010004f0;
    *t = {map};
    err->clear();
    return load_holds(h, kAllowed, t, err);
}

static bool refused(const std::vector<std::string> &pairs, const std::string &why)
{
    std::vector<TargetSpec> t;
    std::string err;
    const bool good = !load(pairs, &t, &err) && t.size() == 1 && err.find(why) != std::string::npos;
    if (!good)
        std::printf("     got \"%s\", %zu targets\n", err.c_str(), t.size());
    return good;
}

int main()
{
    std::vector<TargetSpec> t;
    std::string err;
    ok("off: no hold", load({}, &t, &err) && t.size() == 1);

    ok("on: a hold of 0x105 following the map, never drawn",
       load({"guide_hold=1"}, &t, &err) && t.size() == 2 && t[1].name == "guide_0x105" && t[1].slot == 0x105 &&
           t[1].scene_id == 0x010004f1 && t[1].follows == "map" && t[1].take_over_stock && t[1].linger_ms == 0 &&
           t[1].width == 16 && t[1].height == 16 && t[1].content_class == 0 &&
           t[1].take_over_contents == std::vector<uint64_t>{0x01000310});
    ok("guide_take_over: a list, as given", load({"guide_hold=1", "guide_take_over=0x01000310 0x01000315"}, &t, &err) &&
                                                t[1].take_over_contents ==
                                                    std::vector<uint64_t>{0x01000310, 0x01000315});
    ok("guide_take_over malformed or empty: refused",
       refused({"guide_hold=1", "guide_take_over=0x1000310x"}, "\"0x1000310x\" is not a hex content id") &&
           refused({"guide_hold=1", "guide_take_over=16777744"}, "is not a hex content id") &&
           refused({"guide_hold=1", "guide_take_over= "}, "guide_take_over names no content"));
    ok("two slots, by comma or space: the next scene id each",
       load({"guide_hold=1", "guide_slots=0x105, 0x103"}, &t, &err) && t.size() == 3 && t[2].slot == 0x103 &&
           t[2].scene_id == 0x010004f2 && load({"guide_hold=1", "guide_slots=0x105 0x103"}, &t, &err) &&
           t.size() == 3 && t[2].name == "guide_0x103");
    ok("the class as given", load({"guide_hold=1", "guide_content_class=0x400"}, &t, &err) &&
                                 t[1].content_class == 0x400);

    ok("guide_hold other than 0 or 1: refused", refused({"guide_hold=yes"}, "guide_hold must be 0 or 1") &&
                                                    refused({"guide_hold=2"}, "guide_hold must be 0 or 1") &&
                                                    refused({"guide_hold="}, "guide_hold must be 0 or 1"));
    ok("a placeholder slot: refused", refused({"guide_hold=1", "guide_slots=<slot>"}, "\"<slot>\" is not a slot id"));
    ok("a slot that is not whole hex: refused",
       refused({"guide_hold=1", "guide_slots=0xO5"}, "\"0xO5\" is not a slot id") &&
           refused({"guide_hold=1", "guide_slots=261"}, "\"261\" is not a slot id") &&
           refused({"guide_hold=1", "guide_slots=0x105;0x103"}, "\"0x105;0x103\" is not a slot id"));
    ok("a slot out of 0x1-0xfff: refused", refused({"guide_hold=1", "guide_slots=0x0"}, "\"0x0\"") &&
                                               refused({"guide_hold=1", "guide_slots=0x1000"}, "\"0x1000\""));
    ok("a slot twice: refused", refused({"guide_hold=1", "guide_slots=0x105,0x105"}, "slot 0x105 is listed twice"));
    ok("another target's slot: refused", refused({"guide_hold=1", "guide_slots=0x100"}, "slot 0x100 is target map's"));
    ok("a scene id not allowed: refused, nothing added",
       refused({"guide_hold=1", "guide_slots=0x105,0x103,0x101"}, "guide_0x101's scene id 0x10004f3 is not in "
                                                                  "scene_ids_allowed"));
    ok("a scene id or class that is not a number: refused",
       refused({"guide_hold=1", "guide_scene_id=0x10004fg"}, "guide_scene_id and guide_content_class must be") &&
           refused({"guide_hold=1", "guide_content_class=-1"}, "guide_scene_id and guide_content_class must be"));
    ok("the map's scene id: refused", refused({"guide_hold=1", "guide_scene_id=0x010004f0"},
                                              "guide_0x105's scene id 0x10004f0 is target map's"));
    ok("no slot: refused", refused({"guide_hold=1", "guide_slots= , "}, "guide_slots names no slot"));
    std::vector<TargetSpec> none;
    ok("no map to follow: refused",
       !load_holds(HoldSettings{"1", "0x105", "0x010004f1", "0", "0x01000310"}, kAllowed, &none, &err) &&
                                       err.find("no map target") != std::string::npos);
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
