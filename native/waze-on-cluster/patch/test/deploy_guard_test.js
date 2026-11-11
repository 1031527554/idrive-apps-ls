#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* deploy_guard.js: the map URL edit is held back while mgu-deploy could
 * switch this tool to another version without its deactivate (an mgu-deploy
 * older than 0.7.17; after a firmware update until the tool is set up
 * again), and never without mgu-deploy; the firmware named as mgu-deploy
 * names it. A fake /var/opt/mgu-deploy and /etc in a temporary folder.
 *
 *   node deploy_guard_test.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-guard-'));
var DEPLOY = path.join(dir, 'mgu-deploy'), ETC = path.join(dir, 'etc');
process.env.WOC_DEPLOY_DIR = DEPLOY;
process.env.WOC_ETC = ETC;
var guard = require('../deploy_guard.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function deploy(version, tools) {
    cp.execFileSync('rm', ['-rf', DEPLOY]);
    if (version === null) return;
    fs.mkdirSync(path.join(DEPLOY, 'versions', version), { recursive: true });
    fs.symlinkSync('versions/' + version, path.join(DEPLOY, 'current'));
    if (tools !== undefined) fs.writeFileSync(path.join(DEPLOY, 'state.json'), typeof tools === 'string' ? tools : JSON.stringify({ tools: tools }));
}
fs.mkdirSync(ETC);
fs.writeFileSync(path.join(ETC, 'os-release-id-dlt'), 'MGU_22w28.3-1\nsecond line\n');
var FW = 'MGU_22w28.3-1';

try {
    ok('the firmware as mgu-deploy names it: os-release-id-dlt\'s first line', guard.firmware() === FW, guard.firmware());
    fs.renameSync(path.join(ETC, 'os-release-id-dlt'), path.join(ETC, 'id.away'));
    fs.writeFileSync(path.join(ETC, 'os-release'), 'NAME=x\nPRETTY_NAME="MGU 22.28.3"\n');
    ok('else os-release\'s PRETTY_NAME', guard.firmware() === 'MGU 22.28.3', guard.firmware());
    fs.unlinkSync(path.join(ETC, 'os-release'));
    ok('else none', guard.firmware() === null, guard.firmware());
    fs.renameSync(path.join(ETC, 'id.away'), path.join(ETC, 'os-release-id-dlt'));

    deploy(null);
    ok('no mgu-deploy (installed by hand): not held, hook or not', guard.mapUrlHeld(false) === null && guard.mapUrlHeld(true) === null);

    var mine = { 'waze-on-cluster': { version: '0.9.12', firmware: FW } };
    deploy('0.7.16', mine);
    ok('mgu-deploy 0.7.16 (no deactivate before a rollback): held, also in the activate',
        /mgu-deploy 0\.7\.16 can switch versions/.test(guard.mapUrlHeld(false)) && /0\.7\.16/.test(guard.mapUrlHeld(true)), guard.mapUrlHeld(false));
    deploy('0.7.17', mine);
    ok('mgu-deploy 0.7.17, set up on this firmware: not held', guard.mapUrlHeld(false) === null && guard.mapUrlHeld(true) === null, guard.mapUrlHeld(false));
    deploy('0.8.13', mine);
    ok('mgu-deploy 0.8.13, set up on this firmware: not held', guard.mapUrlHeld(false) === null, guard.mapUrlHeld(false));
    deploy('next', mine);
    ok('an mgu-deploy version it cannot read: held', /can switch versions/.test(guard.mapUrlHeld(true)), guard.mapUrlHeld(true));

    [['installed under another firmware', { version: '0.9.12', firmware: 'MGU_21w27.4-2' }],
     ['laid again after a firmware update, setup owed', { version: '0.9.12', firmware: FW, needsSetup: 'installed under MGU_21w27.4-2' }],
     ['its setup after a firmware update not run yet', { version: '0.9.12', firmware: FW, afterFirmware: true }]].forEach(function (t) {
        deploy('0.8.13', { 'waze-on-cluster': t[1] });
        ok(t[0] + ': held for the Patch button, not in the activate (the setup itself)',
            /to be set up again after a firmware update/.test(guard.mapUrlHeld(false)) && guard.mapUrlHeld(true) === null, guard.mapUrlHeld(false));
    });
    deploy('0.8.13', { 'other-tool': { version: '1.0.0', firmware: FW } });
    ok('no record of this tool: held for the Patch button', /no record of waze-on-cluster/.test(guard.mapUrlHeld(false)) && guard.mapUrlHeld(true) === null);
    deploy('0.8.13', '{"tools":');
    ok('state.json unreadable: held for the Patch button', /no record/.test(guard.mapUrlHeld(false)));
    deploy('0.8.13');
    ok('no state.json: held for the Patch button', /no record/.test(guard.mapUrlHeld(false)));
} finally {
    cp.execFileSync('rm', ['-rf', dir]);
}

process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
