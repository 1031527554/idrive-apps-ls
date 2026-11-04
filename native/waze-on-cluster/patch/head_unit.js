// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* Whether this head unit refuses every part of ours that touches the car's
 * media, GPU or cluster (PATCH.md "Supported head units"), by the
 * bootloader's hwvariant= on the kernel command line. cluster-render's
 * head_unit.cpp holds the same rule for the native services; both run the
 * cases in cluster-render/test/head_unit_cases.jsonl. WOC_CMDLINE points it
 * elsewhere for tests.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');

/* The rule on the command line's text (null: unreadable). */
function rule(cmd) {
    function unknown(why) { return 'head unit: unknown variant is not supported (' + why + ')'; }
    if (cmd === null) return unknown('kernel command line unreadable');
    var values = [], re = /(?:^|\s)hwvariant=(\S*)/g, m;
    while ((m = re.exec(cmd))) values.push(m[1].replace(/^"|"$/g, '').toUpperCase());
    if (!values.some(Boolean)) return unknown('no hwvariant= on the kernel command line');
    var other = values.filter(function (v) { return v !== values[0]; });
    if (other.length) return unknown('the kernel command line says hwvariant=' + values[0] + ' and hwvariant=' + other[0]);
    return null;
}

/* Why our parts must stay inert on this head unit, or null where they run. */
function refused() {
    var cmd;
    try { cmd = fs.readFileSync(process.env.WOC_CMDLINE || '/proc/cmdline', 'utf8'); } catch (e) { cmd = null; }
    return rule(cmd);
}

module.exports = { refused: refused, rule: rule };
