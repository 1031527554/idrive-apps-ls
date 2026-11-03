#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
/* aa-on-cluster's install hooks (component.json "activate" / "deactivate",
 * run by mgu-deploy as root; mgu-store deploy/README.md "Activate and
 * deactivate"), and a status for the shell.
 *
 *   aoc.js activate     the edits in aoc_files.js; idempotent
 *   aoc.js deactivate   everything back as it was
 *   aoc.js status
 *   aoc.js density [150-400 in steps of 10]
 *                       the density the phone is told (lower: more map,
 *                       smaller text); without a number, the current one.
 *                       Re-edits aapd.conf when the tool is active.
 *   aoc.js card [shown|hidden]
 *                       the phone's turn card shown, or cropped off the top
 *                       of the map (experimental); same rules.
 *   aoc.js serve        aa-on-cluster-ctl.service: the control
 *                       socket (root:tm_oap_app 0660), one JSON request per
 *                       connection: status, density, card, restart (the
 *                       Node State Manager's normal restart, as the Store's).
 *
 * The change reaches aapd and waze-on-cluster when they next start, which is
 * the next head-unit start: the last stdout line asks for it ({"reboot"}),
 * and hands over a replaced aapd that still runs ({"removeWhenUnused"}).
 * activate also clears the boot-recovery record, so a reinstall after a
 * restore starts afresh. */
'use strict';

var fs = require('fs');
var path = require('path');
var files = require('./aoc_files.js');

var net = require('net');
var cp = require('child_process');
var aapdConf = require('./aapd_conf.js');

var STATE = process.env.AOC_RECOVERY_STATE || '/var/opt/aa-on-cluster/recovery.json';
var SOCK = process.env.AOC_CTL_SOCKET || '/dev/shm/aa-on-cluster/ctl.sock';
var SOCK_GROUP = process.env.AOC_CTL_GROUP || 'tm_oap_app';
var GROUP_FILE = process.env.AOC_GROUP_FILE || '/etc/group';
/* The head unit's restart, as the Store's (mgu-updater updater.conf
 * `reboot`): the Node State Manager's LifecycleControl.RequestNodeRestart,
 * reason 7 (Application), normal shutdown, the request the HMI's own restart
 * sends, so BMW's services get the normal shutdown. Never `systemctl reboot`:
 * no BMW unit hooks it, and it stops services by their KillSignal (SIGABRT for
 * many, NSM's included). */
var REBOOT_CMD = (process.env.AOC_REBOOT_CMD || '/usr/bin/nsm_control --requestRestart 7 --normal').split(/\s+/).filter(Boolean);
var UPTIME = process.env.AOC_UPTIME || '/proc/uptime';
var REBOOTS = process.env.AOC_REBOOTS || '/var/opt/aa-on-cluster/reboots.json';
/* The Store's limits (mgu-updater rebootWait): none in the first 240 s after
 * a start (a request at every start cannot loop), one per 10 min, three an
 * hour, kept on disk across restarts. */
var REBOOT_MIN_UPTIME_S = parseInt(process.env.AOC_REBOOT_MIN_UPTIME_S, 10) || 240;
var REBOOT_SPACING_MS = 10 * 60 * 1000;
var REBOOT_HOUR_MAX = 3;
var REBOOT_WAIT_MS = parseInt(process.env.AOC_REBOOT_WAIT_MS, 10) || 180000;
var HOUR_MS = 60 * 60 * 1000;
var restart = { busy: false, error: null };
var MAX_LINE = 4096;

function say(line) { process.stdout.write(line + '\n'); }

function last(obj) { say(JSON.stringify(obj)); }

function resetRecovery() {
    try { fs.mkdirSync(path.dirname(STATE)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.writeFileSync(STATE, JSON.stringify({ failures: 0, armedAt: new Date().toISOString() }) + '\n');
}

function activate() {
    if (!files.cropKnown())
        throw new Error('needs waze-on-cluster ' + files.WOC_MIN + ' or newer installed first (found ' +
                        (files.wocVersion() || 'none') + '); nothing changed');
    var r = files.applyFiles();
    say(r.changed ? 'aapd and aapd.conf: cluster map edits in place' : 'aapd and aapd.conf: already edited');
    var crop = files.setCrop();
    say(crop.note || 'waze-on-cluster: src_crop = ' + files.srcCrop(files.card(), files.density()));
    r.warnings.forEach(function (w) { say('warning: ' + w); });
    resetRecovery();
    if (r.changed || crop.changed) {
        var out = { reboot: 'Android Auto shows its cluster map from the next head-unit start' };
        if (r.keep.length) out.removeWhenUnused = r.keep;
        last(out);
    } else last({ status: 'active' });
}

function deactivate() {
    var cropped = files.clearCrop();
    var r = files.revertFiles();
    say(r.changed ? 'aapd and aapd.conf: originals restored' : 'aapd and aapd.conf: nothing of this tool in them');
    r.warnings.forEach(function (w) { say('warning: ' + w); });
    try { fs.unlinkSync(STATE); } catch (e) {}
    if (r.changed || cropped) {
        var out = { reboot: 'Android Auto returns to stock at the next head-unit start' };
        if (r.keep.length) out.removeWhenUnused = r.keep;
        last(out);
    } else last({ status: 'removed' });
}

/* The tool's state for the control socket and the shell: active (aapd carries this
 * tool's edits and aapd.conf is this tool's), inactive (stock: removed or
 * restored by recovery), unknown (a firmware this tool does not know). */
function current() {
    var a = files.aapdState(), c = files.confState();
    var state = a === 'unknown' || c === 'unknown' ? 'unknown'
              : a === 'patched' && (c === 'edited' || c === 'stale') ? 'active' : 'inactive';
    var d = files.density(), k = files.card(), run = files.running();
    return {
        ok: true, state: state, density: d, card: k, running: run,
        pending: state === 'active' && (!run || run.density !== d || run.card !== k),
        restarting: restart.busy, restartError: restart.error,
        choices: aapdConf.DENSITIES, range: { min: aapdConf.DENSITY_MIN, max: aapdConf.DENSITY_MAX, step: aapdConf.DENSITY_STEP },
        cards: aapdConf.CARDS,
    };
}

/* Saves a density or card choice and, while the tool is active, edits
 * aapd.conf (and the crop, for the card) for the next start. Throws on a
 * value outside the choices, having changed nothing. Returns {changed,
 * saved (inactive: used at the next activation), warnings}. */
function choose(what, value) {
    if (what === 'density') files.setDensity(value); else files.setCard(value);
    if (files.aapdState() !== 'patched') return { changed: false, saved: true, warnings: [] };
    var r = files.applyFiles();
    var crop = files.setCrop();      // the crop follows both: the card's cut grows with the density
    return { changed: r.changed || crop.changed, saved: false, warnings: r.warnings.concat(crop.note ? [crop.note] : []) };
}

function choice(what, arg, parse, show) {
    var list = what === 'density' ? aapdConf.DENSITIES : aapdConf.CARDS;
    var now = what === 'density' ? files.density() : files.card();
    if (arg === undefined) { say(what + ': ' + show(now) + ' (choices ' + (what === 'density' ? aapdConf.DENSITY_TEXT : list.join(', ')) + ')'); return; }
    var v = parse(arg);
    var r = choose(what, v);
    r.warnings.forEach(function (w) { say('warning: ' + w); });
    say(r.saved ? what + ' ' + show(v) + ' saved; aa-on-cluster uses it once active'
        : r.changed ? what + ' ' + show(v) + ': edited; restart the head unit for it'
        : what + ' ' + show(v) + ': already in place');
}

function status() {
    var c = current();
    say('state:     ' + c.state + (c.pending ? ' (a change waits for the next head-unit start)' : ''));
    say('aapd:      ' + files.aapdState() + ' (' + files.AAPD + ')');
    say('aapd.conf: ' + files.confState() + ' (' + files.CONF + ')');
    say('density:   ' + c.density + ' dpi');
    say('card:      ' + c.card);
    say('running:   ' + (c.running ? c.running.density + ' dpi, card ' + c.running.card : 'not recorded yet'));
    var local = '';
    try { local = fs.readFileSync(files.WOC_LOCAL, 'utf8'); } catch (e) {}
    var m = /^\s*src_crop\s*=\s*(.*)$/m.exec(local);
    say('src_crop:  ' + (m ? m[1] : 'unset') + ' (' + files.WOC_LOCAL + ')');
    var st = null;
    try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) {}
    say('recovery:  ' + (st ? JSON.stringify(st) : 'no record'));
}

/* ---- the control socket (aa-on-cluster-ctl.service) -------------------- */

/* One request -> one reply; never throws. */
function handle(req) {
    try {
        if (!req || typeof req !== 'object') return { ok: false, error: 'not a request' };
        if (req.cmd === 'status') return current();
        if (req.cmd === 'density' || req.cmd === 'card') {
            var before = current();
            if (before.state === 'unknown') return { ok: false, error: 'a firmware this tool does not know; nothing changed' };
            var v = req.cmd === 'density' ? Number(req.value) : String(req.value);
            var list = req.cmd === 'density' ? aapdConf.DENSITIES : aapdConf.CARDS;
            if (list.indexOf(v) < 0) return { ok: false, error: req.cmd + ' must be ' + (req.cmd === 'density' ? aapdConf.DENSITY_TEXT : 'one of ' + list.join(', ')) };
            choose(req.cmd, v);
            return current();
        }
        if (req.cmd === 'restart') return askRestart();
        return { ok: false, error: 'unknown command' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function groupId(name) {
    try {
        var line = fs.readFileSync(GROUP_FILE, 'utf8').split('\n').filter(function (l) { return l.split(':')[0] === name; })[0];
        if (line) return parseInt(line.split(':')[2], 10);
    } catch (e) {}
    return -1;
}

function uptimeS() {
    try { return parseFloat(fs.readFileSync(UPTIME, 'utf8').split(/\s+/)[0]); } catch (e) { return null; }
}

/* The restarts asked for in the last hour (ms); times ahead of the clock are
 * left out. */
function rebootTimes(now) {
    var at = [];
    try { at = JSON.parse(fs.readFileSync(REBOOTS, 'utf8')).at; } catch (e) {}
    return (Array.isArray(at) ? at : []).filter(function (t) { return isFinite(t) && t <= now && now - t < HOUR_MS; });
}

function recordReboots(times) {
    var tmp = REBOOTS + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: times }) + '\n');
    fs.renameSync(tmp, REBOOTS);
}

/* Why a restart can't be asked for yet, or null (the Store's rebootWait). */
function rebootWait(now) {
    var up = uptimeS();
    if (up === null || isNaN(up)) return 'the head unit\'s uptime is unknown';
    var times = rebootTimes(now), waits = [];
    if (up < REBOOT_MIN_UPTIME_S) waits.push({ why: 'too soon after start-up', ms: (REBOOT_MIN_UPTIME_S - up) * 1000 });
    var last = Math.max.apply(null, [-Infinity].concat(times));
    if (now - last < REBOOT_SPACING_MS) waits.push({ why: 'too soon after the last restart', ms: last + REBOOT_SPACING_MS - now });
    if (times.length >= REBOOT_HOUR_MAX) waits.push({ why: times.length + ' restarts in the last hour', ms: Math.min.apply(null, times) + HOUR_MS - now });
    var w = waits.reduce(function (a, x) { return !a || x.ms > a.ms ? x : a; }, null);
    return w && w.why + ', possible in ' + Math.max(1, Math.ceil(w.ms / 60000)) + ' min';
}

/* The socket's restart request: only while a change is pending, within the limits; the
 * request is on disk before the command runs. Answered at once; the command
 * runs once the answer is sent (reboot). */
function askRestart() {
    if (!current().pending) return { ok: false, error: 'nothing to apply' };
    if (restart.busy) return { ok: true, restarting: true };
    var now = Date.now(), why = rebootWait(now);
    if (why) { say('restart refused: ' + why); return { ok: false, error: why }; }
    try { recordReboots(rebootTimes(now).concat(now)); } catch (e) { return { ok: false, error: 'cannot record the restart: ' + e.message }; }
    restart.busy = true;
    restart.error = null;
    restart.at = now;
    return { ok: true, restarting: true };
}

/* Runs the NSM request. nsm_control exits 0 whether or not NSM took it, and
 * prints "[Error. <why>]" when it could not deliver it; that, a command that
 * can't run, or a unit still up after REBOOT_WAIT_MS ends the restart with
 * the reason in status (restartError). A refused one doesn't count against
 * the limits. */
function reboot() {
    var at = restart.at;
    function failed(why, counts) {
        if (!restart.busy || restart.at !== at) return;
        clearTimeout(timer);
        restart.busy = false;
        restart.error = why;
        say('restart failed: ' + why);
        if (!counts) try { recordReboots(rebootTimes(Date.now()).filter(function (t) { return t !== at; })); } catch (e) {}
    }
    say('restarting the head unit on a control-socket request: ' + REBOOT_CMD.join(' '));
    var timer = setTimeout(function () { failed('the head unit did not restart', true); }, REBOOT_WAIT_MS);
    cp.execFile(REBOOT_CMD[0], REBOOT_CMD.slice(1), { timeout: 60000, maxBuffer: 1 << 20 }, function (err, stdout, stderr) {
        var refused = /\[Error\.\s*([^\]]*)\]/.exec(String(stdout));
        if (err || refused) failed(refused ? refused[1] : String(stderr).trim().split('\n').pop() || err.message.split('\n')[0], false);
    });
}

function serve() {
    files.ensureOwnDir(path.dirname(SOCK));
    try { if (fs.lstatSync(SOCK)) fs.unlinkSync(SOCK); } catch (e) {}
    var server = net.createServer(function (sock) {
        var buf = '', done = false;
        sock.setEncoding('utf8');
        sock.setTimeout(5000, function () { sock.destroy(); });
        sock.on('error', function () {});
        sock.on('data', function (d) {
            if (done) return;
            buf += d;
            var i = buf.indexOf('\n');
            if (i < 0 && buf.length <= MAX_LINE) return;
            done = true;
            var req = null;
            try { req = i >= 0 && i <= MAX_LINE ? JSON.parse(buf.slice(0, i)) : null; } catch (e) {}
            var reply = req ? handle(req) : { ok: false, error: i < 0 || i > MAX_LINE ? 'request too long' : 'not JSON' };
            if (req && reply.ok && req.cmd !== 'status') say(req.cmd + (req.value !== undefined ? ' ' + req.value : '') + ': ' + JSON.stringify(reply));
            sock.end(JSON.stringify(reply) + '\n', function () { if (reply.restarting) setTimeout(reboot, 300); });
        });
    });
    server.on('error', function (e) {
        // systemd starts it again (Restart=always); nothing was changed
        process.stderr.write('aa-on-cluster: control socket ' + SOCK + ': ' + e.message + '\n');
        process.exit(1);
    });
    server.listen(SOCK, function () {
        if (process.getuid && process.getuid() === 0) {
            var gid = groupId(SOCK_GROUP);
            if (gid >= 0) try { fs.chownSync(SOCK, 0, gid); } catch (e) {}
        }
        try { fs.chmodSync(SOCK, 0o660); } catch (e) {}
        say('listening on ' + SOCK);
    });
    process.on('SIGTERM', function () { try { fs.unlinkSync(SOCK); } catch (e) {} process.exit(0); });
}

var cmd = process.argv[2];
try {
    if (cmd === 'activate') activate();
    else if (cmd === 'deactivate') deactivate();
    else if (cmd === 'status') status();
    else if (cmd === 'density') choice('density', process.argv[3], function (a) { return parseInt(a, 10); }, function (v) { return v + ' dpi'; });
    else if (cmd === 'card') choice('card', process.argv[3], String, String);
    else if (cmd === 'serve') serve();
    else { process.stderr.write('usage: aoc.js activate|deactivate|status|density [150-400 step 10]|card [shown|hidden]|serve\n'); process.exit(2); }
} catch (e) {
    process.stderr.write('aa-on-cluster: ' + (e.stderr ? String(e.stderr).trim() + ' ' : '') + e.message + '\n');
    process.exit(1);
}
