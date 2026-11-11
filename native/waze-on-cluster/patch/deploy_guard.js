// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* Whether the carplay patch may carry the map URL edit (PATCH.md "Rollback").
 * Every release before it knows only the other four edits: one that finds
 * the map URL edit in carplay reverts the rest and leaves it. So the edit is
 * written only while mgu-deploy runs this version's deactivate, which
 * removes it, before any version change: a rollback or downgrade does that
 * from mgu-deploy 0.7.17 on, but not, after a firmware update, until this
 * tool is set up again on the new firmware (its activate run there). The
 * firmware name is mgu-deploy's own (its firmwareString). Without
 * mgu-deploy (installed by hand) nothing holds it back.
 *
 * WOC_DEPLOY_DIR and WOC_ETC point it elsewhere for the tests.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');

var DEPLOY = process.env.WOC_DEPLOY_DIR || '/var/opt/mgu-deploy';
var ETC = process.env.WOC_ETC || '/etc';
var ID = 'waze-on-cluster';
/* The first mgu-deploy whose rollback and downgrade run the deactivate of the
 * version they leave (its CHANGELOG, 0.7.17). */
var DEACTIVATES = [0, 7, 17];

function parts(v) { var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || ''); return m ? [+m[1], +m[2], +m[3]] : null; }
function older(a, b) { for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; }

/* The firmware as mgu-deploy names it: the first line of
 * /etc/os-release-id-dlt, else os-release's PRETTY_NAME, at most 120
 * characters; null when neither says. */
function firmware() {
    var t = '', m;
    try { t = fs.readFileSync(path.join(ETC, 'os-release-id-dlt'), 'utf8').split('\n')[0].trim(); } catch (e) {}
    if (!t) {
        try { m = /^PRETTY_NAME=["']?([^"'\n]*)/m.exec(fs.readFileSync(path.join(ETC, 'os-release'), 'utf8')); t = m ? m[1].trim() : ''; } catch (e) {}
    }
    return t ? t.slice(0, 120) : null;
}

/* Why the map URL edit is held back now, or null when it may be written.
 * hook: the write is this version's activate, which mgu-deploy runs only on
 * the firmware it sets the tool up on. */
function mapUrlHeld(hook) {
    var cur;
    try { cur = path.basename(fs.readlinkSync(path.join(DEPLOY, 'current'))); } catch (e) { return null; }
    var v = parts(cur);
    if (!v || older(v, DEACTIVATES)) return 'mgu-deploy ' + cur + ' can switch versions without running this one\'s deactivate';
    if (hook) return null;
    var st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(DEPLOY, 'state.json'), 'utf8')); } catch (e) {}
    var rec = st && st.tools && st.tools[ID];
    if (!rec || typeof rec !== 'object') return 'mgu-deploy has no record of ' + ID;
    var fw = firmware();
    if (rec.afterFirmware || typeof rec.needsSetup === 'string' || (rec.firmware && fw && rec.firmware !== fw))
        return ID + ' is to be set up again after a firmware update';
    return null;
}

module.exports = { mapUrlHeld: mapUrlHeld, firmware: firmware };
