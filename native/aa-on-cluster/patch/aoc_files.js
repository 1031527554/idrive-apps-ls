// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
/* What aa-on-cluster changes outside its own folder, and how it puts it back:
 *
 *   /usr/bin/aapd           the cluster screen ungated and self-started, and
 *                           its 12.3" profile read from aapd.conf
 *                           (aapd_patch.js; backup /usr/bin/aapd.aa-orig)
 *   /etc/aapd.conf          the cluster geometry the phone is given, at the
 *                           owner's density (aapd_conf.js; backup
 *                           /etc/aapd.conf.aoc-orig)
 *   waze-on-cluster's local conf
 *                           src_crop, between two marker lines, so the decoder
 *                           takes that geometry 1:1 (waze-on-cluster.conf)
 *
 * The two files on / are written in one window with / read-write, under the
 * remount lock waze-on-cluster's tools share. A binary a process still runs
 * stays hard-linked beside it (aapd.aoc-running-<ms>) so / can go read-only
 * again; the deploy tool removes it once nothing runs it (removeWhenUnused).
 * Everything takes effect when aapd and waze-on-cluster next start.
 *
 * Synchronous throughout. Node 8, no dependencies. */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./remount_lock.js');
var aapdPatch = require('./aapd_patch.js');
var aapdConf = require('./aapd_conf.js');

var AAPD = process.env.AOC_AAPD || '/usr/bin/aapd';
var CONF = process.env.AOC_CONF || '/etc/aapd.conf';
var WOC_LOCAL = process.env.AOC_WOC_LOCAL || '/var/opt/waze-on-cluster/waze-on-cluster.local.conf';
var WOC_COMPONENT = process.env.AOC_WOC_COMPONENT || '/var/opt/waze-on-cluster/current/component.json';
var MOUNT = process.env.AOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.AOC_PROC_MOUNTS || '/proc/mounts';
var PATCHER = path.join(__dirname, 'aapd_patch.js');
/* The owner's density (one of aapd_conf.js DENSITIES) and turn-card setting
 * (CARDS), kept beside the tool's versions so an update keeps them. */
var DENSITY_FILE = process.env.AOC_DENSITY_FILE || '/var/opt/aa-on-cluster/density';
var CARD_FILE = process.env.AOC_CARD_FILE || '/var/opt/aa-on-cluster/card';
/* What aapd started with this boot ({density, card}), written by the boot
 * check before aapd starts (recovery.js boot); gone after a power-off. */
var RUNNING = process.env.AOC_RUNNING || '/dev/shm/aa-on-cluster/running';

/* The part of the stream waze-on-cluster shows: the top 1280x564 the phone
 * draws in, or, with the card hidden, the rows under the card's band (aapd_conf
 * cardCut: it grows with the density). A cut that leaves fewer than 564 rows
 * narrows the crop to keep the map slot's 1088:480 shape, centred, all numbers
 * even (src_crop's rule). */
function srcCrop(card, dpi) {
    var G = aapdConf.GEOMETRY, W = G.codec.w, H = G.codec.h;
    if (card !== 'hidden') return W + 'x' + H + ':0,0,' + W + ',' + (H - aapdConf.CARD_CUT);
    var cut = aapdConf.cardCut(dpi), h = H - cut;
    if (h >= H - aapdConf.CARD_CUT) return W + 'x' + H + ':0,' + cut + ',' + W + ',' + (H - aapdConf.CARD_CUT);
    var w = Math.min(W, Math.round(h * 1088 / 480 / 2) * 2), x = Math.floor((W - w) / 4) * 2;
    return W + 'x' + H + ':' + x + ',' + cut + ',' + w + ',' + h;
}
var SRC_CROP = srcCrop('shown');
/* The first waze-on-cluster that knows src_crop: an older one refuses to
 * start on a local conf that sets it ("unknown setting"). */
var WOC_MIN = '0.7.10';
var BEGIN = '# aa-on-cluster: begin (set by aa-on-cluster, removed with it)';
var END = '# aa-on-cluster: end';

function sleepMs(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (e) { cp.execFileSync('sleep', [String(ms / 1000)]); }
}

/* aapd: original | patched | partial | unknown (a build this tool does not
 * know, e.g. after a firmware update) | missing. */
function aapdState() {
    var buf;
    try { buf = fs.readFileSync(AAPD); } catch (e) { return 'missing'; }
    var c = aapdPatch.classify(buf);
    if (!c.ok || c.gate.state === 'unknown' || c.sc.state === 'unknown' || c.sg.state === 'unknown' ||
        c.ks.state === 'unknown') return 'unknown';
    var states = [c.gate.state, c.sc.state, c.sg.state, c.ks.state];
    if (states.every(function (s) { return s === 'patched'; })) return 'patched';
    if (states.every(function (s) { return s === 'original'; })) return 'original';
    return 'partial';
}

/* The chosen density, or the default when none is chosen (or the file holds
 * something else). */
function density() {
    var n = parseInt(readText(DENSITY_FILE), 10);
    if (aapdConf.DENSITIES.indexOf(n) >= 0) return n;
    // a retired choice (235) reads as the nearest step (240)
    if (aapdConf.RETIRED.indexOf(n) >= 0) return Math.round(n / aapdConf.DENSITY_STEP) * aapdConf.DENSITY_STEP;
    return aapdConf.DEFAULT_DPI;
}

function setDensity(n) {
    if (aapdConf.DENSITIES.indexOf(n) < 0) throw new Error('density ' + n + ' must be ' + aapdConf.DENSITY_TEXT);
    try { fs.mkdirSync(path.dirname(DENSITY_FILE)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    writeText(DENSITY_FILE, n + '\n');
}

/* The chosen turn-card setting, or the default. */
function card() {
    var v = readText(CARD_FILE).trim();
    return aapdConf.CARDS.indexOf(v) >= 0 ? v : aapdConf.DEFAULT_CARD;
}

function setCard(v) {
    if (aapdConf.CARDS.indexOf(v) < 0) throw new Error('card ' + v + ' is not one of ' + aapdConf.CARDS.join(', '));
    try { fs.mkdirSync(path.dirname(CARD_FILE)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    writeText(CARD_FILE, v + '\n');
}

/* A directory of root's own in the world-writable /dev/shm (never through a
 * symlink or a folder another user made), mode 0755: as waze-on-cluster's
 * patchd makes its socket's. */
function ensureOwnDir(dir) {
    var st = null, uid = process.getuid ? process.getuid() : 0;
    try { st = fs.lstatSync(dir); } catch (e) {}
    if (st) {
        if (!st.isDirectory() || st.uid !== uid) throw new Error(dir + ' is not a directory of uid ' + uid + '; refusing');
    } else fs.mkdirSync(dir, 0o755);
    fs.chmodSync(dir, 0o755);
}

function writeRunning() {
    ensureOwnDir(path.dirname(RUNNING));
    writeText(RUNNING, JSON.stringify({ density: density(), card: card() }) + '\n');
}

/* {density, card} aapd started with this boot, or null before the first
 * start with the boot check. */
function running() {
    try {
        var r = JSON.parse(readText(RUNNING));
        return r && r.density ? { density: r.density, card: r.card || aapdConf.DEFAULT_CARD } : null;
    } catch (e) { return null; }
}

function confState() {
    try { return aapdConf.state(CONF, density(), card()).state; } catch (e) { return 'unknown'; }
}

function rootReadOnly() {
    try {
        var opts = null;
        fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n').forEach(function (l) {
            var p = l.split(' ');
            if (p[1] === '/') opts = p[3];
        });
        return opts !== null && /(^|,)ro(,|$)/.test(opts);
    } catch (e) { return false; }
}

function remount(mode) {
    cp.execFileSync(MOUNT, ['-o', 'remount,' + mode, '/'], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/* Runs fn with / read-write and puts it back as it was. Returns fn's result
 * and the warnings met (a read-only remount that stays busy is one: the files
 * are written either way). */
function withRootWritable(fn) {
    var deadline = Date.now() + 30000;
    while (!lock.tryAcquire()) {
        if (Date.now() > deadline) throw new Error('another tool holds the remount lock');
        sleepMs(200);
    }
    var warnings = [];
    var wasRo = rootReadOnly();
    try {
        if (wasRo) remount('rw');
        return { result: fn(), warnings: warnings };
    } finally {
        if (wasRo) {
            var ok = false, err = null;
            for (var i = 0; i < 5 && !ok; i++) {
                try { remount('ro'); ok = true; } catch (e) { err = e; sleepMs(1000); }
            }
            if (!ok) warnings.push('/ stays read-write until the next start: ' + String(err && err.stderr || err).trim());
        }
        lock.release();
    }
}

/* Keeps a running aapd's file linked before it is replaced. Returns the
 * link, or null when no process runs it. */
function keepRunning() {
    if (!lock.inUse(AAPD)) return null;
    var link = AAPD + '.aoc-running-' + Date.now();
    fs.linkSync(AAPD, link);
    return link;
}

function runPatcher(args) {
    return cp.execFileSync(process.execPath, [PATCHER].concat(args, ['--target', AAPD]),
                           { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/* Both edits on /, in one window. Throws, having changed nothing, when either
 * file is not one this tool knows. Returns {changed, keep, warnings}. */
function applyFiles() {
    var a = aapdState(), c = confState();
    if (a === 'unknown' || a === 'missing') throw new Error(AAPD + ' is not the aapd build this tool knows (' + a + ')');
    if (c !== 'original' && c !== 'edited' && c !== 'stale') throw new Error(CONF + ' is not the aapd.conf this tool knows (' + c + ')');
    if (a === 'patched' && c === 'edited') return { changed: false, keep: [], warnings: [] };
    var keep = [];
    var w = withRootWritable(function () {
        if (a !== 'patched') {
            var link = keepRunning();
            if (link) keep.push(link);
            runPatcher(['apply', '--yes']);
        }
        if (c !== 'edited') aapdConf.apply(CONF, density(), card());
    });
    if (aapdState() !== 'patched' || confState() !== 'edited') throw new Error('the edits did not verify');
    return { changed: true, keep: keep, warnings: w.warnings };
}

/* Both files back to the originals from their backups. A file this tool does
 * not recognise (a firmware update replaced it) is left as it is. */
function revertFiles() {
    var a = aapdState(), c = confState();
    var doA = a === 'patched' || a === 'partial';
    var doC = c === 'edited' || c === 'stale';
    var notes = [];
    if (a === 'unknown') notes.push(AAPD + ' is a build this tool does not know; left as it is');
    if (c === 'unknown') notes.push(CONF + ' is not this tool\'s edit; left as it is');
    if (!doA && !doC) return { changed: false, keep: [], warnings: notes };
    var keep = [];
    var w = withRootWritable(function () {
        if (doA) {
            var link = keepRunning();
            if (link) keep.push(link);
            runPatcher(['revert', '--yes', '--drop-backup']);
        }
        if (doC) aapdConf.revert(CONF, true);
    });
    if ((doA && aapdState() !== 'original') || (doC && confState() !== 'original')) throw new Error('the restore did not verify');
    return { changed: true, keep: keep, warnings: notes.concat(w.warnings) };
}

/* Removes the links keepRunning left that no process runs any more (a
 * restore by recovery.js has no deploy tool to hand them to). */
function dropStaleLinks() {
    var dir = path.dirname(AAPD), base = path.basename(AAPD) + '.aoc-running-';
    var stale = fs.readdirSync(dir).filter(function (n) { return n.indexOf(base) === 0; })
        .map(function (n) { return path.join(dir, n); })
        .filter(function (f) { return !lock.inUse(f); });
    if (!stale.length) return [];
    withRootWritable(function () { stale.forEach(function (f) { fs.unlinkSync(f); }); });
    return stale;
}

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

function withoutBlock(text) {
    var out = [], inside = false;
    text.split('\n').forEach(function (l) {
        if (l === BEGIN) { inside = true; return; }
        if (l === END && inside) { inside = false; return; }
        if (!inside) out.push(l);
    });
    return out.join('\n');
}

function writeText(p, text) {
    var tmp = p + '.aoc-tmp';
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.renameSync(tmp, p);
}

/* The installed waze-on-cluster's version, or null when none is installed. */
function wocVersion() {
    try { return JSON.parse(fs.readFileSync(WOC_COMPONENT, 'utf8')).version || null; } catch (e) { return null; }
}

/* Whether a waze-on-cluster that knows src_crop is installed. */
function cropKnown() {
    var v = wocVersion();
    if (!v) return false;
    var a = v.split('.').map(Number), b = WOC_MIN.split('.').map(Number);
    for (var i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
    return true;
}

/* src_crop in waze-on-cluster's local conf. The owner's own src_crop, outside
 * the block, wins and is never touched. Returns {changed, note}. */
function setCrop() {
    var text = readText(WOC_LOCAL);
    var rest = withoutBlock(text);
    if (/^\s*src_crop\s*=/m.test(rest)) return { changed: false, note: WOC_LOCAL + ' sets its own src_crop; left as it is' };
    var body = rest.replace(/\n*$/, '');
    var next = (body ? body + '\n' : '') + BEGIN + '\nsrc_crop = ' + srcCrop(card(), density()) + '\n' + END + '\n';
    if (next !== text) {
        try { fs.mkdirSync(path.dirname(WOC_LOCAL)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        writeText(WOC_LOCAL, next);
    }
    return { changed: next !== text, note: null };
}

/* Returns whether it changed the file. */
function clearCrop() {
    var text = readText(WOC_LOCAL);
    if (text.indexOf(BEGIN) < 0) return false;
    writeText(WOC_LOCAL, withoutBlock(text).replace(/\n*$/, '\n').replace(/^\n$/, ''));
    return true;
}

module.exports = { AAPD: AAPD, CONF: CONF, WOC_LOCAL: WOC_LOCAL, SRC_CROP: SRC_CROP, WOC_MIN: WOC_MIN,
                   density: density, setDensity: setDensity, card: card, setCard: setCard, srcCrop: srcCrop,
                   running: running, writeRunning: writeRunning, ensureOwnDir: ensureOwnDir,
                   aapdState: aapdState, confState: confState, applyFiles: applyFiles, revertFiles: revertFiles,
                   wocVersion: wocVersion, cropKnown: cropKnown, setCrop: setCrop, clearCrop: clearCrop,
                   dropStaleLinks: dropStaleLinks };
