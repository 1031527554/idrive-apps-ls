// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
/* The install hooks and the recovery, end to end on copies of the unit's own
 * aapd and aapd.conf, with / , /proc, systemctl and the boot id faked.
 * Firmware files are never in this repository: AOC_FIRMWARE names a folder
 * holding usr/bin/aapd and etc/aapd.conf from the unit; without it the test
 * is skipped. */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var assert = require('assert');
var crypto = require('crypto');

var FW = process.env.AOC_FIRMWARE;
if (!FW || !fs.existsSync(path.join(FW, 'usr/bin/aapd'))) {
    console.log('aoc_test: skipped (set AOC_FIRMWARE to a folder with usr/bin/aapd and etc/aapd.conf from the unit)');
    process.exit(0);
}

var PATCH = path.join(__dirname, '..', 'patch');
var AAPD_SHA = '6880f54c3abba40c1368f2bf254c77bd4a169323c0d4cab8f9662a7c912dcf89';
var CONF_SHA = '9584c540f287bb79744e79cf973795208719ca798f13d881c4dac582656b0f16';

function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function setup() {
    var d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'aoc-'));
    ['bin', 'etc', 'proc', 'shm', 'var', 'var/woc', 'var/aoc'].forEach(function (x) { fs.mkdirSync(path.join(d, x)); });
    fs.copyFileSync(path.join(FW, 'usr/bin/aapd'), path.join(d, 'bin/aapd'));
    fs.chmodSync(path.join(d, 'bin/aapd'), 0o755);
    fs.copyFileSync(path.join(FW, 'etc/aapd.conf'), path.join(d, 'etc/aapd.conf'));
    fs.writeFileSync(path.join(d, 'mounts'), '/dev/root / ext4 ro,noatime 0 0\n');
    fs.writeFileSync(path.join(d, 'mount.sh'), '#!/bin/sh\necho "$@" >> "' + path.join(d, 'mount.log') + '"\n');
    fs.chmodSync(path.join(d, 'mount.sh'), 0o755);
    fs.writeFileSync(path.join(d, 'boot_id'), 'boot-1\n');
    fs.writeFileSync(path.join(d, 'unit'), 'MainPID=100\nActiveState=active\n');
    fs.writeFileSync(path.join(d, 'sys'), 'running\n');
    fs.writeFileSync(path.join(d, 'systemctl.sh'), '#!/bin/sh\necho "$@" >> "' + path.join(d, 'systemctl.calls') + '"\nif [ "$1" = is-system-running ]; then cat "' +
                     path.join(d, 'sys') + '"; exit 1; fi\ncat "' + path.join(d, 'unit') + '"\n');
    fs.writeFileSync(path.join(d, 'var/woc/component.json'), JSON.stringify({ id: 'waze-on-cluster', version: '0.7.10' }));
    fs.chmodSync(path.join(d, 'systemctl.sh'), 0o755);
    var env = Object.assign({}, process.env, {
        AOC_AAPD: path.join(d, 'bin/aapd'),
        AOC_CONF: path.join(d, 'etc/aapd.conf'),
        AOC_WOC_LOCAL: path.join(d, 'var/woc/waze-on-cluster.local.conf'),
        AOC_WOC_COMPONENT: path.join(d, 'var/woc/component.json'),
        AOC_MOUNT: path.join(d, 'mount.sh'),
        AOC_PROC_MOUNTS: path.join(d, 'mounts'),
        AOC_RECOVERY_STATE: path.join(d, 'var/aoc/recovery.json'),
        AOC_DENSITY_FILE: path.join(d, 'var/aoc/density'),
        AOC_CARD_FILE: path.join(d, 'var/aoc/card'),
        AOC_RUNNING: path.join(d, 'shm/aoc/running'),
        AOC_CTL_SOCKET: path.join(d, 'shm/aoc/ctl.sock'),
        AOC_GROUP_FILE: path.join(d, 'group'),
        AOC_BOOT_ID: path.join(d, 'boot_id'),
        AOC_SYSTEMCTL: path.join(d, 'systemctl.sh'),
        AOC_RECOVERY_POLL_MS: '50',
        AOC_RECOVERY_HEALTHY_MS: '400',
        AOC_RECOVERY_SURVIVE_MS: '200',
        WOC_REMOUNT_LOCK: path.join(d, 'shm/remount.lock'),
        WOC_PROC: path.join(d, 'proc'),
    });
    return { d: d, env: env, p: function (x) { return path.join(d, x); } };
}

function run(t, script, args) {
    var r = cp.spawnSync(process.execPath, [path.join(PATCH, script)].concat(args), { env: t.env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr, last: lastJson(r.stdout) };
}

function lastJson(out) {
    var lines = out.trim().split('\n');
    try { return JSON.parse(lines[lines.length - 1]); } catch (e) { return null; }
}

function mountCalls(t) { try { return fs.readFileSync(t.p('mount.log'), 'utf8').trim().split('\n'); } catch (e) { return []; } }

/* --- activate / deactivate ------------------------------------------------ */
(function hooks() {
    var t = setup();
    fs.writeFileSync(t.env.AOC_WOC_LOCAL, '# owner\ntarget_fps = 30\n');

    var a = run(t, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err);
    assert.ok(a.last && /next head-unit start/.test(a.last.reboot), a.out);
    assert.ok(!a.last.removeWhenUnused, 'no process ran aapd');
    assert.notStrictEqual(sha(t.env.AOC_AAPD), AAPD_SHA);
    assert.notStrictEqual(sha(t.env.AOC_CONF), CONF_SHA);
    assert.strictEqual(sha(t.env.AOC_AAPD + '.aa-orig'), AAPD_SHA);
    assert.strictEqual(sha(t.env.AOC_CONF + '.aoc-orig'), CONF_SHA);
    assert.deepStrictEqual(mountCalls(t), ['-o remount,rw /', '-o remount,ro /']);
    var local = fs.readFileSync(t.env.AOC_WOC_LOCAL, 'utf8');
    assert.ok(/^target_fps = 30$/m.test(local) && /^src_crop = 1280x720:0,0,1280,564$/m.test(local), local);
    var st = run(t, 'aoc.js', ['status']).out;
    assert.ok(/aapd:\s+patched/.test(st) && /aapd.conf:\s+edited/.test(st), st);

    var again = run(t, 'aoc.js', ['activate']);
    assert.strictEqual(again.code, 0, again.err);
    assert.deepStrictEqual(again.last, { status: 'active' });
    assert.strictEqual(mountCalls(t).length, 2, 'an idempotent activate does not remount');

    var d = run(t, 'aoc.js', ['deactivate']);
    assert.strictEqual(d.code, 0, d.err);
    assert.ok(d.last && /stock/.test(d.last.reboot), d.out);
    assert.strictEqual(sha(t.env.AOC_AAPD), AAPD_SHA);
    assert.strictEqual(sha(t.env.AOC_CONF), CONF_SHA);
    assert.ok(!fs.existsSync(t.env.AOC_AAPD + '.aa-orig') && !fs.existsSync(t.env.AOC_CONF + '.aoc-orig'), 'backups dropped');
    assert.strictEqual(fs.readFileSync(t.env.AOC_WOC_LOCAL, 'utf8'), '# owner\ntarget_fps = 30\n');
    assert.deepStrictEqual(run(t, 'aoc.js', ['deactivate']).last, { status: 'removed' });
    console.log('aoc_test: hooks ok');
})();

/* A running aapd stays linked and is handed to the deploy tool. */
(function running() {
    var t = setup();
    fs.mkdirSync(t.p('proc/4242'));
    fs.symlinkSync(t.env.AOC_AAPD, t.p('proc/4242/exe'));
    var a = run(t, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err);
    assert.strictEqual(a.last.removeWhenUnused.length, 1, a.out);
    var link = a.last.removeWhenUnused[0];
    assert.strictEqual(sha(link), AAPD_SHA, 'the link keeps the running original');
    console.log('aoc_test: running aapd ok');
})();

/* The car's state from the first release: aapd with the gate and selfstart
 * edits only, aapd.conf with the earlier 1920x1080 edit, the earlier crop.
 * activate brings all three to this release; deactivate restores stock. */
(function upgrade() {
    var conf = require(path.join(PATCH, 'aapd_conf.js'));
    var patch = require(path.join(PATCH, 'aapd_patch.js'));
    var t = setup();
    var origConf = fs.readFileSync(t.env.AOC_CONF, 'utf8');
    fs.writeFileSync(t.env.AOC_CONF + '.aoc-orig', origConf, { mode: 0o600 });
    fs.writeFileSync(t.env.AOC_CONF, conf.transform(origConf, conf.STALE[0]));
    fs.writeFileSync(t.env.AOC_WOC_LOCAL, '# aa-on-cluster: begin (set by aa-on-cluster, removed with it)\n' +
                     'src_crop = 800x480:0,0,800,300\n# aa-on-cluster: end\n');
    var r = cp.spawnSync(process.execPath, [path.join(PATCH, 'aapd_patch.js'), 'apply', '--yes', '--target', t.env.AOC_AAPD], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    var buf = fs.readFileSync(t.env.AOC_AAPD);
    fs.readFileSync(t.env.AOC_AAPD + '.aa-orig').copy(buf, patch.KNOWN.ks_offset, patch.KNOWN.ks_offset, patch.KNOWN.ks_offset + 16);
    fs.writeFileSync(t.env.AOC_AAPD, buf);
    var st = run(t, 'aoc.js', ['status']).out;
    assert.ok(/aapd:\s+partial/.test(st) && /aapd.conf:\s+stale/.test(st), st);

    var a = run(t, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err + a.out);
    st = run(t, 'aoc.js', ['status']).out;
    assert.ok(/aapd:\s+patched/.test(st) && /aapd.conf:\s+edited/.test(st) && /src_crop:\s+1280x720:0,0,1280,564/.test(st), st);
    assert.strictEqual((fs.readFileSync(t.env.AOC_WOC_LOCAL, 'utf8').match(/src_crop/g) || []).length, 1);

    var d = run(t, 'aoc.js', ['deactivate']);
    assert.strictEqual(d.code, 0, d.err);
    assert.strictEqual(sha(t.env.AOC_AAPD), AAPD_SHA);
    assert.strictEqual(sha(t.env.AOC_CONF), CONF_SHA);

    /* deactivate straight from the first release's state */
    var u = setup();
    var oc = fs.readFileSync(u.env.AOC_CONF, 'utf8');
    fs.writeFileSync(u.env.AOC_CONF + '.aoc-orig', oc, { mode: 0o600 });
    fs.writeFileSync(u.env.AOC_CONF, conf.transform(oc, conf.STALE[0]));
    var dd = run(u, 'aoc.js', ['deactivate']);
    assert.strictEqual(dd.code, 0, dd.err);
    assert.strictEqual(sha(u.env.AOC_CONF), CONF_SHA);

    /* from 0.2.0: all four aapd edits, the 800x480 edit and its crop */
    var v = setup();
    var vc = fs.readFileSync(v.env.AOC_CONF, 'utf8');
    fs.writeFileSync(v.env.AOC_CONF + '.aoc-orig', vc, { mode: 0o600 });
    fs.writeFileSync(v.env.AOC_CONF, conf.transform(vc, conf.STALE[1]));
    fs.writeFileSync(v.env.AOC_WOC_LOCAL, '# aa-on-cluster: begin (set by aa-on-cluster, removed with it)\n' +
                     'src_crop = 800x480:0,0,800,352\n# aa-on-cluster: end\n');
    r = cp.spawnSync(process.execPath, [path.join(PATCH, 'aapd_patch.js'), 'apply', '--yes', '--target', v.env.AOC_AAPD], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    st = run(v, 'aoc.js', ['status']).out;
    assert.ok(/aapd:\s+patched/.test(st) && /aapd.conf:\s+stale/.test(st), st);
    a = run(v, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err + a.out);
    st = run(v, 'aoc.js', ['status']).out;
    assert.ok(/aapd.conf:\s+edited/.test(st) && /src_crop:\s+1280x720:0,0,1280,564/.test(st), st);
    d = run(v, 'aoc.js', ['deactivate']);
    assert.strictEqual(d.code, 0, d.err);
    assert.strictEqual(sha(v.env.AOC_AAPD), AAPD_SHA);
    assert.strictEqual(sha(v.env.AOC_CONF), CONF_SHA);
    console.log('aoc_test: upgrade ok');
})();

/* The density: 180 until chosen, any of the three chosen before or after
 * activation, others refused; an earlier release's density is re-edited. */
(function densityChoice() {
    var conf = require(path.join(PATCH, 'aapd_conf.js'));
    function dens(t) {
        var k = JSON.parse(fs.readFileSync(t.env.AOC_CONF, 'utf8')).SCREENS.KOMBI_DISPLAY;
        return [k.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY, k.CODEC_DEFINITION.MID_1080P.REAL_SCREEN_DENSITY,
                k.DIMENSIONS['12.3'].SA_PHYSICALDENSITY, k.DIMENSIONS['10.25'].SA_PHYSICALDENSITY].join();
    }
    var t = setup();
    var a = run(t, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err + a.out);
    assert.strictEqual(dens(t), '180,180,180,180');
    var r = run(t, 'aoc.js', ['density', '240']);
    assert.strictEqual(r.code, 0, r.err + r.out);
    assert.ok(/restart the head unit/.test(r.out), r.out);
    assert.strictEqual(dens(t), '240,240,240,240');
    var st = run(t, 'aoc.js', ['status']).out;
    assert.ok(/aapd.conf:\s+edited/.test(st) && /density:\s+240 dpi/.test(st), st);
    r = run(t, 'aoc.js', ['density', '155']);
    assert.notStrictEqual(r.code, 0);
    assert.strictEqual(dens(t), '240,240,240,240');
    a = run(t, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err + a.out);
    assert.strictEqual(dens(t), '240,240,240,240');
    var d = run(t, 'aoc.js', ['deactivate']);
    assert.strictEqual(d.code, 0, d.err);
    assert.strictEqual(sha(t.env.AOC_CONF), CONF_SHA);

    var u = setup();
    r = run(u, 'aoc.js', ['density', '200']);
    assert.ok(r.code === 0 && /saved/.test(r.out), r.err + r.out);
    a = run(u, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err + a.out);
    assert.strictEqual(dens(u), '200,200,200,200');

    var v = setup();
    var vc = fs.readFileSync(v.env.AOC_CONF, 'utf8');
    fs.writeFileSync(v.env.AOC_CONF + '.aoc-orig', vc, { mode: 0o600 });
    fs.writeFileSync(v.env.AOC_CONF, conf.transform(vc, conf.geometry(235)));
    var cr = cp.spawnSync(process.execPath, [path.join(PATCH, 'aapd_patch.js'), 'apply', '--yes', '--target', v.env.AOC_AAPD], { encoding: 'utf8' });
    assert.strictEqual(cr.status, 0, cr.stderr);
    assert.ok(/aapd.conf:\s+stale/.test(run(v, 'aoc.js', ['status']).out));
    a = run(v, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err + a.out);
    assert.strictEqual(dens(v), '180,180,180,180');
    console.log('aoc_test: density ok');
})();

/* The turn card: hidden is the whole 1280x720 as UI with the safe area from
 * the top and the crop under the card's band; every density x card is this
 * tool's edit (stale when not the chosen one) and comes back to stock. */
(function cardChoice() {
    var conf = require(path.join(PATCH, 'aapd_conf.js'));
    function kombi(t) { return JSON.parse(fs.readFileSync(t.env.AOC_CONF, 'utf8')).SCREENS.KOMBI_DISPLAY; }
    function crop(t) { var m = /^src_crop = (.*)$/m.exec(fs.readFileSync(t.env.AOC_WOC_LOCAL, 'utf8')); return m && m[1]; }
    var t = setup();
    assert.strictEqual(run(t, 'aoc.js', ['activate']).code, 0);
    var r = run(t, 'aoc.js', ['card', 'hidden']);
    assert.strictEqual(r.code, 0, r.err + r.out);
    var k = kombi(t), c = k.CODEC_DEFINITION.HIGH_1080P, sa = k.DIMENSIONS['12.3'];
    assert.deepStrictEqual([c.CODEC_WIDTH, c.CODEC_HEIGHT, c.HORIZONTAL_MARGIN_SIZE, c.VERTICAL_MARGIN_SIZE, c.HEIGHT_TARGET_VIEWPORT, c.REPORTED_SCREEN_DENSITY],
                           [1280, 720, 0, 0, 720, 180]);
    assert.deepStrictEqual([sa.SA_OFFSET_LEFTPIXELS, sa.SA_OFFSET_TOPPIXELS, sa.SA_WIDTHPIXELS, sa.SA_HEIGHTPIXELS], [336, 0, 592, 672]);
    assert.strictEqual(crop(t), '1280x720:0,156,1280,564');
    var st = run(t, 'aoc.js', ['status']).out;
    assert.ok(/aapd.conf:\s+edited/.test(st) && /card:\s+hidden/.test(st), st);
    assert.notStrictEqual(run(t, 'aoc.js', ['card', 'gone']).code, 0);
    assert.strictEqual(run(t, 'aoc.js', ['density', '240']).code, 0);
    assert.strictEqual(kombi(t).CODEC_DEFINITION.MID_1080P.REAL_SCREEN_DENSITY, 240);
    assert.strictEqual(crop(t), '1280x720:4,160,1270,560', 'a density change moves the card\'s cut with it (240)');
    // the cut follows the density: the card grows with it (aapd_conf cardCut); 180/200 keep 156
    [['180', '1280x720:0,156,1280,564'], ['200', '1280x720:0,156,1280,564'], ['300', '1280x720:46,196,1188,524'],
     ['400', '1280x720:116,258,1048,462']].forEach(function (c) {
        assert.strictEqual(run(t, 'aoc.js', ['density', c[0]]).code, 0);
        assert.strictEqual(crop(t), c[1], 'hidden at ' + c[0]);
        // every number even, inside the 1280x720 picture, the slot's 1088:480 shape (+-1%)
        var n = c[1].split(':')[1].split(',').map(Number);
        assert.ok(n.every(function (v) { return v % 2 === 0; }) && n[0] + n[2] <= 1280 && n[1] + n[3] <= 720, c[1]);
        assert.ok(Math.abs(n[2] / n[3] / (1088 / 480) - 1) < 0.01, c[1]);
    });
    assert.strictEqual(run(t, 'aoc.js', ['density', '240']).code, 0);
    assert.strictEqual(run(t, 'aoc.js', ['card', 'shown']).code, 0);
    assert.strictEqual(crop(t), '1280x720:0,0,1280,564');
    assert.strictEqual(kombi(t).CODEC_DEFINITION.HIGH_1080P.VERTICAL_MARGIN_SIZE, 156);
    assert.strictEqual(run(t, 'aoc.js', ['deactivate']).code, 0);
    assert.strictEqual(sha(t.env.AOC_CONF), CONF_SHA);

    // every combination, written as an earlier choice: recognised (in-process, all 34), and for the
    // edges of the range end to end: re-edited to the current one by activate, restored by deactivate
    var orig = fs.readFileSync(t.env.AOC_CONF, 'utf8');
    var v = setup();
    assert.strictEqual(run(v, 'aoc.js', ['activate']).code, 0);
    conf.DENSITIES.concat(conf.RETIRED).forEach(function (d) {
        conf.CARDS.forEach(function (card) {
            fs.writeFileSync(v.env.AOC_CONF, conf.transform(orig, conf.geometry(d, card)));
            var want = d === conf.DEFAULT_DPI && card === conf.DEFAULT_CARD ? 'edited' : 'stale';
            assert.strictEqual(conf.state(v.env.AOC_CONF, conf.DEFAULT_DPI, conf.DEFAULT_CARD).state, want, d + ' ' + card);
            assert.strictEqual(conf.state(v.env.AOC_CONF, d, card).state, 'edited', d + ' ' + card);
            assert.strictEqual(conf.revert(v.env.AOC_CONF), 'restored the original', d + ' ' + card);
            assert.strictEqual(sha(v.env.AOC_CONF), CONF_SHA, d + ' ' + card);
        });
    });
    [[150, 'hidden'], [400, 'shown'], [235, 'hidden']].forEach(function (c) {
        var u = setup();
        assert.strictEqual(run(u, 'aoc.js', ['activate']).code, 0);
        fs.writeFileSync(u.env.AOC_CONF, conf.transform(orig, conf.geometry(c[0], c[1])));
        assert.strictEqual(run(u, 'aoc.js', ['activate']).code, 0);
        assert.strictEqual(conf.state(u.env.AOC_CONF, conf.DEFAULT_DPI, conf.DEFAULT_CARD).state, 'edited');
        fs.writeFileSync(u.env.AOC_CONF, conf.transform(orig, conf.geometry(c[0], c[1])));
        assert.strictEqual(run(u, 'aoc.js', ['deactivate']).code, 0);
        assert.strictEqual(sha(u.env.AOC_CONF), CONF_SHA, c.join(' '));
    });
    // the range: its edges and steps chosen end to end; a value off the steps refused
    var w = setup();
    assert.strictEqual(run(w, 'aoc.js', ['activate']).code, 0);
    ['150', '300', '400', '270', '240'].forEach(function (d) {
        assert.strictEqual(run(w, 'aoc.js', ['density', d]).code, 0, d);
        assert.strictEqual(kombi(w).CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY, Number(d));
    });
    ['145', '155', '235', '410'].forEach(function (d) {
        var r2 = run(w, 'aoc.js', ['density', d]);
        assert.ok(r2.code !== 0 && /150-400 dpi in steps of 10/.test(r2.err), d + ' ' + r2.err);
    });
    // a saved retired choice (235, from 0.3.0/0.4.0) reads as 240 and activates as 240
    fs.writeFileSync(w.env.AOC_DENSITY_FILE, '235\n');
    assert.strictEqual(run(w, 'aoc.js', ['activate']).code, 0);
    assert.strictEqual(kombi(w).CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY, 240);
    assert.ok(/density:\s+240 dpi/.test(run(w, 'aoc.js', ['status']).out));
    console.log('aoc_test: card ok');
})();

/* The owner's own src_crop wins; a firmware update's files are refused. */
(function guards() {
    var t = setup();
    fs.writeFileSync(t.env.AOC_WOC_LOCAL, 'src_crop = 1920x1080:2,2,1088,480\n');
    var a = run(t, 'aoc.js', ['activate']);
    assert.strictEqual(a.code, 0, a.err);
    assert.ok(/sets its own src_crop/.test(a.out), a.out);
    assert.strictEqual(fs.readFileSync(t.env.AOC_WOC_LOCAL, 'utf8'), 'src_crop = 1920x1080:2,2,1088,480\n');

    var u = setup();
    fs.appendFileSync(u.env.AOC_CONF, '\n');
    var r = run(u, 'aoc.js', ['activate']);
    assert.strictEqual(r.code, 1);
    assert.ok(/not the aapd.conf this tool knows/.test(r.err), r.err);
    assert.strictEqual(sha(u.env.AOC_AAPD), AAPD_SHA, 'nothing changed');
    assert.deepStrictEqual(mountCalls(u), []);

    var o = setup();
    fs.writeFileSync(o.env.AOC_WOC_COMPONENT, JSON.stringify({ id: 'waze-on-cluster', version: '0.7.8' }));
    var old = run(o, 'aoc.js', ['activate']);
    assert.strictEqual(old.code, 1);
    assert.ok(/needs waze-on-cluster 0.7.10 or newer installed first \(found 0.7.8\)/.test(old.err), old.err);
    assert.strictEqual(sha(o.env.AOC_AAPD), AAPD_SHA, 'nothing changed');
    assert.ok(!fs.existsSync(o.env.AOC_WOC_LOCAL));
    assert.deepStrictEqual(mountCalls(o), []);
    fs.unlinkSync(o.env.AOC_WOC_COMPONENT);
    assert.ok(/found none/.test(run(o, 'aoc.js', ['activate']).err));
    console.log('aoc_test: guards ok');
})();

/* --- recovery --------------------------------------------------------------- */
(function bootLoop() {
    var t = setup();
    assert.strictEqual(run(t, 'aoc.js', ['activate']).code, 0);
    run(t, 'recovery.js', ['boot']);
    for (var b = 2; b <= 3; b++) {
        fs.writeFileSync(t.env.AOC_BOOT_ID, 'boot-' + b + '\n');
        run(t, 'recovery.js', ['boot']);
    }
    assert.strictEqual(sha(t.env.AOC_AAPD), AAPD_SHA, 'two unhealthy boots restore stock aapd');
    assert.strictEqual(sha(t.env.AOC_CONF), CONF_SHA);
    var s = JSON.parse(fs.readFileSync(t.env.AOC_RECOVERY_STATE, 'utf8'));
    assert.ok(s.restored && s.failures === 0, JSON.stringify(s));
    assert.ok(!/src_crop/.test(fs.readFileSync(t.env.AOC_WOC_LOCAL, 'utf8')));

    var h = setup();
    assert.strictEqual(run(h, 'aoc.js', ['activate']).code, 0);
    run(h, 'recovery.js', ['boot']);
    var st = JSON.parse(fs.readFileSync(h.env.AOC_RECOVERY_STATE, 'utf8'));
    st.ran = true;
    fs.writeFileSync(h.env.AOC_RECOVERY_STATE, JSON.stringify(st));
    fs.writeFileSync(h.env.AOC_BOOT_ID, 'boot-2\n');
    run(h, 'recovery.js', ['boot']);
    fs.writeFileSync(h.env.AOC_BOOT_ID, 'boot-3\n');
    run(h, 'recovery.js', ['boot']);
    assert.notStrictEqual(sha(h.env.AOC_AAPD), AAPD_SHA, 'one short boot after one where aapd ran keeps the edits');

    /* waze-on-cluster rolled back below 0.7.10: src_crop goes before it starts */
    var r = setup();
    assert.strictEqual(run(r, 'aoc.js', ['activate']).code, 0);
    run(r, 'recovery.js', ['boot']);
    assert.ok(/src_crop/.test(fs.readFileSync(r.env.AOC_WOC_LOCAL, 'utf8')), 'kept for 0.7.10');
    fs.writeFileSync(r.env.AOC_WOC_COMPONENT, JSON.stringify({ id: 'waze-on-cluster', version: '0.7.8' }));
    var rb = run(r, 'recovery.js', ['boot']);
    assert.ok(/src_crop taken out: waze-on-cluster 0.7.8/.test(rb.out), rb.out);
    assert.strictEqual(fs.readFileSync(r.env.AOC_WOC_LOCAL, 'utf8'), '');
    assert.notStrictEqual(sha(r.env.AOC_AAPD), AAPD_SHA, 'aapd keeps its edits');
    console.log('aoc_test: boot recovery ok');
})();

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

(function crashWatch() {
    var t = setup();
    assert.strictEqual(run(t, 'aoc.js', ['activate']).code, 0);
    var w = cp.spawn(process.execPath, [path.join(PATCH, 'recovery.js'), 'watch'], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    var out = '';
    w.stdout.on('data', function (b) { out += b; });
    var steps = [
        [300, 'MainPID=101\nActiveState=active\n'],
        [300, 'MainPID=0\nActiveState=activating\n'],
    ];
    var i = 0;
    (function next() {
        if (i === steps.length) {
            setTimeout(function () {
                w.kill('SIGTERM');
                assert.strictEqual(sha(t.env.AOC_AAPD), AAPD_SHA, 'two aapd failures restore stock aapd: ' + out);
                assert.strictEqual(sha(t.env.AOC_CONF), CONF_SHA);
                console.log('aoc_test: crash watch ok');
                stoppingWatch();
            }, 600);
            return;
        }
        setTimeout(function () { fs.writeFileSync(t.p('unit'), steps[i][1]); i++; next(); }, steps[i][0]);
    })();
})();

/* aapd stopping with the system is no failure, and the next boot keeps the edits. */
function stoppingWatch() {
    var t = setup();
    assert.strictEqual(run(t, 'aoc.js', ['activate']).code, 0);
    run(t, 'recovery.js', ['boot']);
    var w = cp.spawn(process.execPath, [path.join(PATCH, 'recovery.js'), 'watch'], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    var out = '';
    w.stdout.on('data', function (b) { out += b; });
    setTimeout(function () {
        fs.writeFileSync(t.p('sys'), 'stopping\n');
        fs.writeFileSync(t.p('unit'), 'MainPID=0\nActiveState=deactivating\n');
        setTimeout(function () {
            w.kill('SIGTERM');
            setTimeout(function () {
                var s = JSON.parse(fs.readFileSync(t.env.AOC_RECOVERY_STATE, 'utf8'));
                assert.ok(!s.failures && s.cleanStop, JSON.stringify(s) + out);
                fs.writeFileSync(t.env.AOC_BOOT_ID, 'boot-2\n');
                run(t, 'recovery.js', ['boot']);
                s = JSON.parse(fs.readFileSync(t.env.AOC_RECOVERY_STATE, 'utf8'));
                assert.ok(!s.failures, JSON.stringify(s));
                assert.notStrictEqual(sha(t.env.AOC_AAPD), AAPD_SHA);
                console.log('aoc_test: stopping watch ok');
                healthyWatch();
            }, 300);
        }, 300);
    }, 100);
}

function healthyWatch() {
    var t = setup();
    assert.strictEqual(run(t, 'aoc.js', ['activate']).code, 0);
    fs.writeFileSync(t.env.AOC_RECOVERY_STATE, JSON.stringify({ failures: 1 }));
    var w = cp.spawn(process.execPath, [path.join(PATCH, 'recovery.js'), 'watch'], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    setTimeout(function () {
        var s = JSON.parse(fs.readFileSync(t.env.AOC_RECOVERY_STATE, 'utf8'));
        assert.ok(s.healthy && s.ran && s.failures === 0, JSON.stringify(s));
        w.kill('SIGTERM');
        setTimeout(function () {
            var s2 = JSON.parse(fs.readFileSync(t.env.AOC_RECOVERY_STATE, 'utf8'));
            assert.strictEqual(s2.cleanStop, true, 'a stop with aapd running is clean');
            assert.notStrictEqual(sha(t.env.AOC_AAPD), AAPD_SHA, 'a healthy aapd keeps the edits');
            console.log('aoc_test: healthy watch ok');
            serveDaemon();
        }, 300);
    }, 900);
}

/* The control socket: status, density, card, restart (refused
 * with nothing pending, a reboot through systemctl when pending), bad
 * requests answered and nothing changed. */
function serveDaemon() {
    var net = require('net');
    var t = setup();
    fs.writeFileSync(t.env.AOC_GROUP_FILE, 'tm_oap_app:x:12202:\n');
    assert.strictEqual(run(t, 'aoc.js', ['activate']).code, 0);
    fs.mkdirSync(t.p('shm/aoc'));
    fs.writeFileSync(t.env.AOC_RUNNING, JSON.stringify({ density: 180, card: 'shown' }));
    // the NSM request, faked: it records its arguments and answers as nsm_control does when NSM
    // can't be reached (exit 0, "[Error. ...]")
    fs.writeFileSync(t.p('nsm.sh'), '#!/bin/sh\necho "$@" >> "' + t.p('nsm.calls') + '"\necho "[Error. ProxyLifecycleControl not available!]"\n');
    fs.chmodSync(t.p('nsm.sh'), 0o755);
    fs.writeFileSync(t.p('uptime'), '100.00 50.00\n');
    var env = Object.assign({}, t.env, { AOC_REBOOT_CMD: t.p('nsm.sh') + ' --requestRestart 7 --normal', AOC_UPTIME: t.p('uptime'),
                                         AOC_REBOOTS: t.p('var/aoc/reboots.json') });
    var d = cp.spawn(process.execPath, [path.join(PATCH, 'aoc.js'), 'serve'], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    var log = '';
    d.stdout.on('data', function (b) { log += b; });
    d.stderr.on('data', function (b) { log += b; });
    function ask(line, cb) {
        var s = net.connect(t.env.AOC_CTL_SOCKET), buf = '';
        s.on('connect', function () { s.write(line + '\n'); });
        s.on('data', function (b) { buf += b; });
        s.on('end', function () { cb(JSON.parse(buf)); });
        s.on('error', function (e) { throw new Error(e.message + ' / ' + log); });
    }
    var steps = [
        ['{"cmd":"status"}', function (r) {
            assert.ok(r.ok && r.state === 'active' && r.density === 180 && r.card === 'shown' && r.pending === false, JSON.stringify(r));
            assert.strictEqual(r.choices.length, 26);
            assert.deepStrictEqual(r.range, { min: 150, max: 400, step: 10 });
            assert.strictEqual((fs.statSync(t.env.AOC_CTL_SOCKET).mode & 0o777).toString(8), '660');
        }],
        ['{"cmd":"restart"}', function (r) { assert.ok(!r.ok && /nothing to apply/.test(r.error), JSON.stringify(r)); }],
        ['{"cmd":"density","value":155}', function (r) { assert.ok(!r.ok && /150-400 dpi in steps of 10/.test(r.error), JSON.stringify(r)); }],
        ['{"cmd":"card","value":"x"}', function (r) { assert.ok(!r.ok, JSON.stringify(r)); }],
        ['{"cmd":"rm -rf"}', function (r) { assert.ok(!r.ok && /unknown command/.test(r.error), JSON.stringify(r)); }],
        ['not json', function (r) { assert.ok(!r.ok && /not JSON/.test(r.error), JSON.stringify(r)); }],
        ['{"cmd":"density","value":200}', function (r) {
            assert.ok(r.ok && r.density === 200 && r.pending === true, JSON.stringify(r));
            assert.strictEqual(JSON.parse(fs.readFileSync(t.env.AOC_CONF, 'utf8')).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY, 200);
        }],
        ['{"cmd":"card","value":"hidden"}', function (r) {
            assert.ok(r.ok && r.card === 'hidden' && r.pending, JSON.stringify(r));
            assert.ok(/src_crop = 1280x720:0,156,1280,564/.test(fs.readFileSync(t.env.AOC_WOC_LOCAL, 'utf8')));
        }],
        ['{"cmd":"restart"}', function (r) {
            assert.ok(!r.ok && /too soon after start-up, possible in \d+ min/.test(r.error), JSON.stringify(r));
            assert.ok(!fs.existsSync(t.p('nsm.calls')));
            fs.writeFileSync(t.p('uptime'), '1000.00 50.00\n');
        }],
        ['{"cmd":"restart"}', function (r) { assert.ok(r.ok && r.restarting, JSON.stringify(r)); }],
        ['wait', function () {
            assert.strictEqual(fs.readFileSync(t.p('nsm.calls'), 'utf8'), '--requestRestart 7 --normal\n');
            assert.ok(!/reboot/.test(fs.existsSync(t.p('systemctl.calls')) ? fs.readFileSync(t.p('systemctl.calls'), 'utf8') : ''), 'never systemctl reboot');
        }],
        ['{"cmd":"status"}', function (r) {
            assert.ok(r.restarting === false && r.restartError === 'ProxyLifecycleControl not available!', JSON.stringify(r));
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(t.p('var/aoc/reboots.json'), 'utf8')).at, [], 'a refused restart does not count');
        }],
    ];
    function next(i) {
        if (i === steps.length) {
            d.kill('SIGTERM');
            console.log('aoc_test: serve ok');
            return;
        }
        if (steps[i][0] === 'wait') return setTimeout(function () { steps[i][1](); next(i + 1); }, 800);
        ask(steps[i][0], function (r) { steps[i][1](r); next(i + 1); });
    }
    (function wait(n) {
        if (fs.existsSync(t.env.AOC_CTL_SOCKET)) return next(0);
        if (n > 100) throw new Error('the daemon did not listen: ' + log);
        setTimeout(function () { wait(n + 1); }, 50);
    })(0);
}
