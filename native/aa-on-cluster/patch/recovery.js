#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
/* recovery.js — puts stock aapd and aapd.conf back on its own when the
 * cluster edits make aapd crash, so a bad edit can never leave the owner
 * without Android Auto, or the head unit in a restart loop.
 *
 *   recovery.js watch   (aa-on-cluster-recovery.service, all the time)
 *       Follows aapd.service's main PID. aapd running one PID for HEALTHY_MS
 *       clears the failure count. aapd dying or being replaced by another PID
 *       counts one failure, unless the system is stopping; at THRESHOLD the
 *       originals go back on disk at once, so aapd's next start (recmgr
 *       restarts it, the install adds aapd to its lists) is the stock one.
 *   recovery.js boot    (aa-on-cluster-boot.service, before aapd and
 *                        waze-on-cluster start)
 *       A previous boot in which aapd never ran one PID for SURVIVE_MS (a
 *       crash at start that rebooted the unit before the watch saw it) counts
 *       one failure; at THRESHOLD the originals go back before aapd starts.
 *       A switch-off stops no service, so the record, not a SIGTERM, tells
 *       a short boot from a bad one. It also takes this tool's src_crop out
 *       of a waze-on-cluster too old to know it (one the Store rolled back),
 *       which would otherwise refuse to start, and records the density and
 *       turn card aapd starts with (aoc_files.js writeRunning).
 *
 * It only guards an aapd it patched itself (aoc_files.js aapdState
 * "patched"); with stock files it does nothing and clears the count. It
 * never stops, restarts or kills anything, and never reboots: it only
 * replaces files, through the same verified revert the removal uses. The
 * record is /var/opt/aa-on-cluster/recovery.json; `aoc.js status` shows it.
 * Node 8, no dependencies. */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var files = require('./aoc_files.js');

var STATE = process.env.AOC_RECOVERY_STATE || '/var/opt/aa-on-cluster/recovery.json';
var BOOT_ID = process.env.AOC_BOOT_ID || '/proc/sys/kernel/random/boot_id';
var SYSTEMCTL = process.env.AOC_SYSTEMCTL || 'systemctl';
var THRESHOLD = parseInt(process.env.AOC_RECOVERY_THRESHOLD, 10) || 2;
var HEALTHY_MS = parseInt(process.env.AOC_RECOVERY_HEALTHY_MS, 10) || 120000;
var SURVIVE_MS = parseInt(process.env.AOC_RECOVERY_SURVIVE_MS, 10) || 20000;
var POLL_MS = parseInt(process.env.AOC_RECOVERY_POLL_MS, 10) || 2000;

function log(msg) { process.stdout.write('aa-on-cluster recovery: ' + msg + '\n'); }

function bootId() { try { return fs.readFileSync(BOOT_ID, 'utf8').trim(); } catch (e) { return ''; } }

function load() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { failures: 0 }; }
}

function save(s) {
    try { fs.mkdirSync(path.dirname(STATE)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    var tmp = STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s) + '\n');
    fs.renameSync(tmp, STATE);
}

/* {active, pid} of aapd.service; null when systemctl cannot be read. */
function aapdUnit() {
    try {
        var out = cp.execFileSync(SYSTEMCTL, ['show', '-p', 'MainPID', '-p', 'ActiveState', 'aapd.service'],
                                  { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
        var pid = /MainPID=(\d+)/.exec(out), act = /ActiveState=(\S+)/.exec(out);
        return { active: !!act && act[1] === 'active', pid: pid ? parseInt(pid[1], 10) : 0 };
    } catch (e) { return null; }
}

/* systemctl is-system-running exits non-zero for every state but running. */
function stopping() {
    var r = cp.spawnSync(SYSTEMCTL, ['is-system-running'], { encoding: 'utf8', timeout: 10000 });
    return (r.stdout || '').trim() === 'stopping';
}

function restore(s, why) {
    log('restoring stock aapd and aapd.conf: ' + why);
    try {
        files.clearCrop();
        var r = files.revertFiles();
        r.warnings.forEach(function (w) { log('warning: ' + w); });
        s.failures = 0;
        s.restored = { at: new Date().toISOString(), why: why };
        save(s);
        log('restored; reinstall aa-on-cluster from the Store to try again');
    } catch (e) {
        log('restore failed (' + e.message + '); the count is kept, so the next check tries again');
        save(s);
    }
}

/* Whether aapd is this tool's patched build; read again only when the file
 * changes (it is 7 MB). */
var seen = { key: null, patched: false };
function guarded() {
    var st;
    try { st = fs.statSync(files.AAPD); } catch (e) { return false; }
    var key = st.ino + ':' + st.size + ':' + st.mtime.getTime();
    if (key !== seen.key) seen = { key: key, patched: files.aapdState() === 'patched' };
    return seen.patched;
}

function boot() {
    try { files.dropStaleLinks().forEach(function (f) { log('removed ' + f); }); }
    catch (e) { log('could not remove old aapd links: ' + e.message); }
    try {
        if (files.wocVersion() && !files.cropKnown() && files.clearCrop())
            log('src_crop taken out: waze-on-cluster ' + files.wocVersion() + ' does not know it');
    } catch (e) { log('could not take src_crop out: ' + e.message); }
    // what aapd starts with this boot (density, card), for `aoc.js status`
    // and the control socket's "pending" (aoc.js current)
    try { files.writeRunning(); } catch (e) { log('could not record the running settings: ' + e.message); }
    var s = load();
    if (!guarded()) { if (s.failures) { s.failures = 0; save(s); } return; }
    var id = bootId();
    if (s.boot && s.boot !== id && !s.ran && !s.cleanStop) {
        s.failures = (s.failures || 0) + 1;
        log('the last boot never ran aapd ' + Math.round(SURVIVE_MS / 1000) + ' s (' + s.failures + ' of ' + THRESHOLD + ')');
    }
    s.boot = id;
    s.ran = false;
    s.healthy = false;
    s.cleanStop = false;
    if (s.failures >= THRESHOLD) restore(s, s.failures + ' boots in a row without a healthy aapd');
    else save(s);
}

function watch() {
    var s = load();
    var lastPid = 0, since = 0;
    process.on('SIGTERM', function () {
        var u = aapdUnit();
        var cur = load();
        cur.cleanStop = stopping() || !!(u && u.active && u.pid && u.pid === lastPid);
        save(cur);
        process.exit(0);
    });
    function tick() {
        if (!guarded()) { lastPid = 0; return; }
        var u = aapdUnit();
        if (!u) return;
        var now = Date.now();
        var pid = u.active ? u.pid : 0;
        if (lastPid && pid !== lastPid && stopping()) {
            s = load();
            s.cleanStop = true;
            save(s);
            log('aapd ' + lastPid + ' stopped with the system');
            lastPid = pid;
            since = now;
            return;
        }
        if (lastPid && pid !== lastPid) {
            s = load();
            s.failures = (s.failures || 0) + 1;
            s.healthy = false;
            log('aapd ' + lastPid + (pid ? ' was replaced by ' + pid : ' stopped') + ' (' + s.failures + ' of ' + THRESHOLD + ')');
            if (s.failures >= THRESHOLD) restore(s, s.failures + ' aapd failures in a row');
            else save(s);
            since = now;
        } else if (!lastPid && pid) since = now;
        lastPid = pid;
        if (pid && now - since >= SURVIVE_MS) {
            s = load();
            if (!s.ran) {
                s.ran = true;
                save(s);
            }
        }
        if (pid && now - since >= HEALTHY_MS) {
            s = load();
            if (!s.healthy || s.failures) {
                s.healthy = true;
                s.failures = 0;
                save(s);
                log('aapd ' + pid + ' healthy for ' + Math.round(HEALTHY_MS / 1000) + ' s; count cleared');
            }
        }
    }
    tick();
    setInterval(tick, POLL_MS);
}

var cmd = process.argv[2];
if (cmd === 'boot') boot();
else if (cmd === 'watch') watch();
else { process.stderr.write('usage: recovery.js boot|watch\n'); process.exit(2); }
