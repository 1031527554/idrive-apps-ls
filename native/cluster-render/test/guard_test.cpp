/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the mapping guard (guard.h): a strike kept in its file and
 * read back; a mapping disabled at its target's strike limit, also after a
 * reload; a limit of 0 never disabling; another version's file started
 * over; a strike expiring after 24 h, or after 3 new boots with no other
 * strike (not after a reload in the same boot), a disabled mapping kept
 * either way; a reset; a file that does not read started over; a file that
 * cannot be written leaving the guard working. */
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "../src/guard.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const std::string kPath = "/tmp/crs-guard-test-" + std::to_string(getpid()) + ".txt";
static int64_t wall = 1800000000;

static TargetSpec spec(const char *name, uint64_t slot, uint64_t scene, int limit)
{
    TargetSpec t;
    t.name = name;
    t.slot = slot;
    t.scene_id = scene;
    t.strike_limit = limit;
    return t;
}

static const TargetSpec kHold = spec("guide_0x105", 0x105, 0x010004f1, 2), kMap = spec("map", 0x100, 0x010004f0, 0);

/* A guard read from the file, as at a start of cluster-render. */
static void load(Guard *g, const char *version = "0.3.7", const char *boot = "boot-1")
{
    g->clock = [] { return wall; };
    g->load(kPath, version, boot);
}

int main()
{
    unlink(kPath.c_str());
    {
        Guard g;
        load(&g);
        ok("no file: no strike", g.status_text().empty() && !g.disabled(kHold));
        ok("one strike: not disabled", !g.strike(kHold, "300 ms after mapping it") && !g.disabled(kHold));
    }
    {
        Guard g;
        load(&g);
        ok("read back: one strike", g.status_text() == "guard: guide_0x105 0x105 0x10004f1 0: 1 strike\n");
        ok("the second: disabled", g.strike(kHold, "200 ms after mapping it") && g.disabled(kHold));
        ok("another mapping of the target is not", !g.disabled(spec("guide_0x105", 0x103, 0x010004f1, 2)));
        for (int k = 0; k < 5; k++)
            g.strike(kMap, "100 ms after mapping it");
        ok("strike limit 0: never disabled", !g.disabled(kMap));
    }
    {
        Guard g;
        load(&g, "0.3.7", "boot-2");
        ok("after a reboot: still disabled, the map's strikes kept",
           g.disabled(kHold) && g.status_text() == "guard: guide_0x105 0x105 0x10004f1 0: disabled, 2 strikes\n"
                                                   "guard: map 0x100 0x10004f0 0: 5 strikes\n");
    }
    {
        Guard g;
        load(&g, "0.3.8", "boot-2");
        ok("another version: started over", !g.disabled(kHold) && g.status_text().empty());
        g.strike(kHold, "1 ms after mapping it");
    }
    wall += 24 * 3600;
    {
        Guard g;
        load(&g, "0.3.8", "boot-2");
        ok("24 h later: the strike expired", g.status_text().empty());
        g.strike(kHold, "1 ms after mapping it");
        g.strike(kHold, "1 ms after mapping it");
    }
    wall += 48 * 3600;
    {
        Guard g;
        load(&g, "0.3.8", "boot-2");
        ok("a disabled mapping does not expire", g.disabled(kHold));
        g.reset();
        ok("reset: nothing disabled", !g.disabled(kHold) && g.status_text().empty());
        g.strike(kHold, "1 ms after mapping it");
    }
    for (const char *boot : {"boot-2", "boot-3", "boot-4"}) {
        Guard g;
        load(&g, "0.3.8", boot);
    }
    {
        Guard g;
        load(&g, "0.3.8", "boot-4");
        ok("two new boots and a reload: the strike still counts",
           g.status_text() == "guard: guide_0x105 0x105 0x10004f1 0: 1 strike\n");
    }
    {
        Guard g;
        load(&g, "0.3.8", "boot-5");
        ok("the third new boot without a strike: expired", g.status_text().empty());
    }
    {
        std::ofstream(kPath) << "version 0.3.8\nboot boot-5\nguide_0x105 0x105\n";
        Guard g;
        load(&g, "0.3.8", "boot-5");
        ok("a file that does not read: started over", g.status_text().empty() && !g.disabled(kHold));
    }
    {
        Guard g;
        g.clock = [] { return wall; };
        g.load("/nonexistent-dir/guard.txt", "0.3.8", "boot-5");
        g.strike(kHold, "1 ms after mapping it");
        ok("a file that cannot be written: the guard still disables", g.strike(kHold, "1 ms after mapping it") &&
                                                                         g.disabled(kHold));
    }
    unlink(kPath.c_str());
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
