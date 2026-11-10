#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs_extra — the parts of the Save logs archive (collect-logs.sh) that
 * are read with care: only read, each file at most CAP bytes, and every text
 * passed through scrub(), which replaces anything shaped like a VIN (17
 * characters) or a short VIN (7) with <VIN>.
 *
 *   node logs_extra.js report <dir>
 *       as the logs service's user, into dir:
 *       patch-record-carplay.json, patch-record-aapd.json
 *                          the patchers' records (patch_record.js)
 *       aa-boot-recovery.json
 *                          the aapd boot recovery's state (recovery.js)
 *       coding.txt         the cluster coding's KI_KOMBI_VARIANT, the number
 *                          only (aapd_patch.js readCoding)
 *       deploy.txt         the deploy tool's version; each tool installed
 *                          (/var/opt/<id>/current/component.json: id, kind,
 *                          version); and from the deploy tool's state.json
 *                          the tools' versions and firmware, the apps'
 *                          versions, the pending restarts and the last
 *                          bounce. Nothing else of it or of the updater: not
 *                          their tokens, credentials, sources, config or
 *                          backups.
 *
 *   node logs_extra.js snapshot [dir]
 *       as root (waze-on-cluster-logs-fw.service before the logs service
 *       starts, or collect-logs.sh run by root): BMW's records under
 *       /var/opt/public, which only root reads, into dir (default SNAPSHOT,
 *       made group systemd-journal, mode 2750, and emptied first; files
 *       0640):
 *       restartInfo-recmgr.xml, restartInfo-crashhandler.xml
 *                          recmgr's and crashhandler's restart records, when
 *                          there (each deletes its own at its start)
 *       recmgr-crashes.txt recmgr_stats.db's Crash table, its newest ROWS
 *                          rows: key, time, the application's name, crash
 *                          id, lifecycle. Not its UserID column (7
 *                          characters, the size of a short VIN). The
 *                          firmware's sqlite3 opens the database read-only
 *                          (file:...?mode=ro) and is killed after SQLITE_MS.
 *       core-dumps.txt     the names and modification times (UTC) of what
 *                          the crash handler and the kernel keep of crashes
 *                          (DUMPS, two levels deep, at most ENTRIES each),
 *                          never their contents
 *
 * A source that is absent is left out; one that cannot be read says why in
 * its file. WOC_LOGS_ROOT prefixes every path read (tests).
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = process.env.WOC_LOGS_ROOT || '';
var SQLITE3 = process.env.WOC_SQLITE3 || 'sqlite3';
var SNAPSHOT = '/run/waze-on-cluster-logs';
var CAP = 64 * 1024;
var ROWS = 200;
var ENTRIES = 100;
var SQLITE_MS = 2000;
var SIN = '/var/opt/public/sin';
var DUMPS = [SIN + '/crashhandler/coredumps', SIN + '/crashhandler/gpu_hangs', SIN + '/gcd', SIN + '/dlt-cdh', '/var/opt/kerneldump'];

function r(p) { return ROOT + p; }

/* A VIN (17 of A-HJ-NPR-Z0-9, with a letter and a digit) or a short VIN (a
 * letter and 6 digits, or 2 and 5), standing alone: <VIN>. */
var VIN = /(^|[^A-Za-z0-9])([A-HJ-NPR-Z0-9]{17}|[A-Z][0-9]{6}|[A-Z]{2}[0-9]{5})(?![A-Za-z0-9])/gi;
function scrub(text) {
    return String(text).replace(VIN, function (m, pre, tok) {
        if (tok.length === 17 && !(/[0-9]/.test(tok) && /[A-Z]/i.test(tok))) return m;
        return pre + '<VIN>';
    });
}

/* text cut to CAP bytes, with a closing line saying so */
function capped(text) {
    var b = Buffer.from(text, 'utf8');
    if (b.length <= CAP) return text;
    return b.slice(0, CAP - 64).toString('utf8') + '\n... (cut at ' + CAP + ' bytes)\n';
}

/* A regular file's first CAP bytes as text (never through a link), or null
 * when absent; throws when it cannot be read. */
function readCapped(file) {
    var st;
    try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!st.isFile()) return null;
    var fd = fs.openSync(file, 'r');
    try {
        var b = Buffer.alloc(Math.min(st.size, CAP)), n = fs.readSync(fd, b, 0, b.length, 0);
        return b.slice(0, n).toString('utf8') + (st.size > CAP ? '\n... (cut at ' + CAP + ' of ' + st.size + ' bytes)\n' : '');
    } finally { fs.closeSync(fd); }
}

function put(dir, name, text) {
    fs.writeFileSync(path.join(dir, name), capped(scrub(text)), { mode: 0o640 });
}

/* copy of a small file: absent left out, unreadable said */
function copyFile(dir, name, file) {
    var text;
    try { text = readCapped(file); } catch (e) { text = '(unreadable: ' + e.code + ')\n'; }
    if (text !== null) put(dir, name, text);
}

function readJson(file) {
    var text = readCapped(file);
    return text === null ? null : JSON.parse(text);
}

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }
function str(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : '?'; }

/* ---- report ---------------------------------------------------------------- */

function codingText() {
    var cd = require('./aapd_patch.js').readCoding(r('/dev/shm/rawcodingdata'));
    return (cd.err ? 'unreadable (' + cd.err + ')' : 'KI_KOMBI_VARIANT ' + cd.variant) + '\n';
}

function deployText() {
    var out = [], varOpt = r('/var/opt'), v = null;
    try { v = fs.readlinkSync(path.join(varOpt, 'mgu-deploy', 'current')); } catch (e) { /* not installed */ }
    out.push('mgu-deploy ' + (v ? path.basename(v) : 'absent'));
    out.push('tools installed (/var/opt/<id>/current):');
    var names = [];
    try { names = fs.readdirSync(varOpt).sort(); } catch (e) { out.push('  (' + e.code + ')'); }
    names.forEach(function (n) {
        var cur = path.join(varOpt, n, 'current');
        try { if (!fs.lstatSync(cur).isSymbolicLink()) return; } catch (e) { return; }
        var c = null;
        try { c = readJson(path.join(cur, 'component.json')); } catch (e) { out.push('  ' + n + ' (component.json: ' + (e.code || 'not JSON') + ')'); return; }
        if (c && typeof c === 'object') out.push('  ' + str(c.kind) + ' ' + str(c.id) + ' ' + str(c.version));
    });
    var s = null;
    try { s = readJson(path.join(varOpt, 'mgu-deploy', 'state.json')); } catch (e) { out.push('state.json: ' + (e.code || 'not JSON')); }
    if (s && typeof s === 'object') {
        out.push('state.json:');
        var tools = s.tools && typeof s.tools === 'object' ? s.tools : {};
        Object.keys(tools).sort().forEach(function (id) {
            var t = tools[id] || {};
            out.push('  tool ' + id + ' ' + str(t.version) + (t.firmware ? ' firmware ' + str(t.firmware) : '') +
                (t.needsSetup ? ' (needs setup: ' + str(t.needsSetup) + ')' : '') + (t.afterFirmware ? ' (after a firmware update)' : ''));
        });
        var apps = s.apps && typeof s.apps === 'object' ? s.apps : {};
        Object.keys(apps).sort().forEach(function (id) { out.push('  app ' + id + ' ' + str((apps[id] || {}).version)); });
        (Array.isArray(s.pending_reboot) ? s.pending_reboot : []).forEach(function (p) {
            if (p && typeof p === 'object') out.push('  pending restart: ' + str(p.id) + ' - ' + str(p.reason));
        });
        if (typeof s.lastBounceAt === 'number' && s.lastBounceAt > 0) out.push('  last bounce: ' + iso(s.lastBounceAt * 1000));
    }
    return out.join('\n') + '\n';
}

function report(dir) {
    copyFile(dir, 'patch-record-carplay.json', r('/usr/bin/carplay.woc-patch.json'));
    copyFile(dir, 'patch-record-aapd.json', r('/usr/bin/aapd.woc-patch.json'));
    copyFile(dir, 'aa-boot-recovery.json', r('/var/opt/waze-on-cluster/aa-boot-recovery.json'));
    [['coding.txt', codingText], ['deploy.txt', deployText]].forEach(function (p) {
        var text;
        try { text = p[1](); } catch (e) { text = '(failed: ' + e.message + ')\n'; }
        put(dir, p[0], text);
    });
}

/* ---- snapshot -------------------------------------------------------------- */

/* recmgr_stats.db's Crash table, or null without the database */
function crashesText() {
    var db = r(SIN + '/recmgr/recmgr_stats.db');
    try { if (!fs.lstatSync(db).isFile()) return null; } catch (e) { return null; }
    var sql = 'SELECT c.CrashKey, c.Timestamp, a.Name, c.CrashID, c.LC FROM Crash c LEFT JOIN Appl a ON a.ID = c.AppID ' +
        'ORDER BY c.CrashKey DESC LIMIT ' + ROWS + ';';
    var res = cp.spawnSync(SQLITE3, ['-header', 'file:' + db + '?mode=ro', sql],
        { cwd: '/', encoding: 'utf8', timeout: SQLITE_MS, killSignal: 'SIGKILL', maxBuffer: 4 * CAP, stdio: ['ignore', 'pipe', 'pipe'] });
    var head = '-- ' + SIN + '/recmgr/recmgr_stats.db Crash, newest first (at most ' + ROWS + ')\n';
    if (res.error) return head + '(' + (res.error.code === 'ETIMEDOUT' ? 'sqlite3 killed after ' + SQLITE_MS + ' ms' : 'sqlite3: ' + res.error.code) + ')\n';
    return head + (res.stdout || '') + (res.status ? '(sqlite3 exit ' + res.status + ': ' + String(res.stderr || '').trim().slice(0, 300) + ')\n' :
        res.stdout ? '' : '(no rows)\n');
}

/* names and times under each of DUMPS, two levels, newest first */
function dumpsText() {
    var out = [];
    DUMPS.forEach(function (base) {
        var lines = [];
        function walk(rel, depth) {
            var names;
            try { names = fs.readdirSync(r(base) + rel); } catch (e) {
                if (!rel) { if (e.code !== 'ENOENT') out.push('-- ' + base + '\n(' + e.code + ')'); return; }
                lines.push({ t: 0, s: '(' + e.code + ') ' + rel.slice(1) + '/' });
                return;
            }
            names.forEach(function (n) {
                var st;
                try { st = fs.lstatSync(r(base) + rel + '/' + n); } catch (e) { return; }
                lines.push({ t: st.mtime.getTime(), s: iso(st.mtime.getTime()) + '  ' + (rel + '/' + n).slice(1) + (st.isDirectory() ? '/' : '') });
                if (st.isDirectory() && depth < 2) walk(rel + '/' + n, depth + 1);
            });
            if (!rel) {
                lines.sort(function (a, b) { return b.t - a.t; });
                out.push('-- ' + base + (lines.length > ENTRIES ? ' (the newest ' + ENTRIES + ' of ' + lines.length + ')' : ''));
                lines.slice(0, ENTRIES).forEach(function (l) { out.push(l.s); });
                if (!lines.length) out.push('(empty)');
            }
        }
        walk('', 1);
    });
    return out.join('\n') + '\n';
}

function snapshot(dir) {
    copyFile(dir, 'restartInfo-recmgr.xml', r(SIN + '/recmgr/restartInfo.xml'));
    copyFile(dir, 'restartInfo-crashhandler.xml', r(SIN + '/crashhandler/restartInfo.xml'));
    [['recmgr-crashes.txt', crashesText], ['core-dumps.txt', dumpsText]].forEach(function (p) {
        var text;
        try { text = p[1](); } catch (e) { text = '(failed: ' + e.message + ')\n'; }
        if (text !== null) put(dir, p[0], text);
    });
}

/* SNAPSHOT for the logs service's group to read: root's, group
 * systemd-journal, 2750, without the last snapshot's files */
function snapshotDir() {
    try { fs.mkdirSync(SNAPSHOT, 0o750); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!fs.lstatSync(SNAPSHOT).isDirectory()) throw new Error(SNAPSHOT + ' is not a folder');
    fs.chownSync(SNAPSHOT, 0, require('./group_dir.js').gid('systemd-journal'));
    fs.chmodSync(SNAPSHOT, 0o2750);
    fs.readdirSync(SNAPSHOT).forEach(function (n) { fs.unlinkSync(path.join(SNAPSHOT, n)); });
    return SNAPSHOT;
}

if (require.main === module) {
    var cmd = process.argv[2], dir = process.argv[3];
    if (cmd === 'report' && dir) report(dir);
    else if (cmd === 'snapshot') snapshot(dir || snapshotDir());
    else { process.stderr.write('usage: logs_extra.js report <dir> | snapshot [dir]\n'); process.exit(2); }
}

module.exports = { scrub: scrub, report: report, snapshot: snapshot, CAP: CAP, ROWS: ROWS, ENTRIES: ENTRIES, SQLITE_MS: SQLITE_MS };
