#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* journal_keep — the tools' part of the journal, kept on /var/opt, where it
 * outlives the unit's volatile journal (about four minutes on the car) and
 * its reboots. waze-on-cluster-journal.service runs it as a dynamic user in
 * the systemd-journal group.
 *
 * journalctl follows this boot's entries of UNITS, systemd's lines about
 * them and the kernel's. Each becomes one line of at most LINE_MAX bytes,
 *   2026-11-03T06:58:54.365447Z cluster-render.service cluster-render[1152]: <message>
 * appended to DIR/journal.log every FLUSH_MS, the file opened only for the
 * write. A file that would pass FILE_MAX becomes journal.log.1, the older
 * ones move up and journal.log.<FILES-1> is dropped. The tools' lines
 * (waze-on-cluster, cluster-render) and the others (carplay, recmgr,
 * crashhandler, the kernel) each have RATE / 2 bytes a minute, with a
 * minute's worth in reserve, so a flood of one kind never pushes out the
 * other; what comes faster is dropped and counted in one line per flush.
 *
 * The caps hold the last 10 minutes whatever the units log: every rotated
 * file holds more than FILE_MAX - LINE_MAX bytes, so the files keep at least
 * (FILES - 1) * (FILE_MAX - LINE_MAX) = 3447 KiB, and in any 10 minutes the
 * limit lets through at most 11 * RATE = 2816 KiB.
 *
 * A start (or journalctl's) resumes after the newest line the files hold,
 * from this boot's start when they hold none of this boot.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var DIR = process.env.WOC_JOURNAL_DIR || '/var/opt/waze-on-cluster/journal';
var JOURNALCTL = process.env.WOC_JOURNALCTL || 'journalctl';
var FILE = 'journal.log';
var FILES = 10;
var FILE_MAX = 384 * 1024;
var LINE_MAX = 1024;
var RATE = 256 * 1024;
var FLUSH_MS = Number(process.env.WOC_JOURNAL_FLUSH_MS) || 2000;
var RESPAWN_MS = Number(process.env.WOC_JOURNAL_RESPAWN_MS) || 10000;
var PENDING_MAX = 256 * 1024;

var UNITS = ['waze-on-cluster.service', 'waze-on-cluster-patchd.service', 'waze-on-cluster-boot.service',
    'waze-on-cluster-recovery.service', 'waze-on-cluster-capture.service', 'waze-on-cluster-journal.service',
    'waze-on-cluster-logs.service', 'cluster-render.service', 'carplay.service', 'recmgr.service',
    'crashhandler.service'];
var SOCKETS = ['waze-on-cluster.socket', 'waze-on-cluster-logs.socket', 'cluster-render.socket'];

/* journalctl's arguments: the units' own entries, systemd's about them and
 * the units' sockets, and the kernel's; sinceUs (µs) resumes after a line. */
function journalArgs(sinceUs) {
    var args = ['-b', '-f', '--no-tail', '--no-pager', '-o', 'json',
        '--output-fields=MESSAGE,_SYSTEMD_UNIT,UNIT,SYSLOG_IDENTIFIER,_PID,_TRANSPORT'];
    if (sinceUs) args.push('--since=@' + Math.floor(sinceUs / 1e6) + '.' + String(sinceUs % 1e6).padStart(6, '0'));
    UNITS.forEach(function (u) { args.push('_SYSTEMD_UNIT=' + u); });
    args.push('+', '_PID=1');
    UNITS.concat(SOCKETS).forEach(function (u) { args.push('UNIT=' + u); });
    args.push('+', '_TRANSPORT=kernel');
    return args;
}

function isoUs(us) {
    return new Date(Math.floor(us / 1000)).toISOString().slice(0, 19) + '.' + String(us % 1e6).padStart(6, '0') + 'Z';
}

function text(v) {
    if (Array.isArray(v)) return Buffer.from(v).toString('utf8');
    return v === null || v === undefined ? '' : String(v);
}

/* One journal entry (journalctl -o json) as { us, line, tool } with its
 * newline (tool: a line of waze-on-cluster or cluster-render), or null. */
function format(entry) {
    var us = Number(entry.__REALTIME_TIMESTAMP);
    if (!(us > 0)) return null;
    var msg = text(entry.MESSAGE).replace(/[\r\n]+/g, ' ');
    var unit = entry._TRANSPORT === 'kernel' ? '' :
        entry._SYSTEMD_UNIT && entry._SYSTEMD_UNIT !== 'init.scope' ? entry._SYSTEMD_UNIT : text(entry.UNIT) || '-';
    var head = unit ? unit + ' ' + text(entry.SYSLOG_IDENTIFIER || '?') + (entry._PID ? '[' + text(entry._PID) + ']' : '') + ':' :
        'kernel:';
    var b = Buffer.from(isoUs(us) + ' ' + head + ' ' + msg, 'utf8');
    if (b.length > LINE_MAX - 1) b = b.slice(0, LINE_MAX - 1);
    return { us: us, line: Buffer.concat([b, Buffer.from('\n')]), tool: /^(waze-on-cluster|cluster-render)[.-]/.test(unit) };
}

/* A token bucket of rate bytes a minute holding at most a minute's worth.
 * now() in ms. */
function Limiter(rate, now) {
    this.rate = rate;
    this.now = now || Date.now;
    this.tokens = rate;
    this.at = this.now();
    this.droppedLines = 0;
    this.droppedBytes = 0;
}
Limiter.prototype.take = function (n) {
    var t = this.now();
    this.tokens = Math.min(this.rate, this.tokens + (t - this.at) * this.rate / 60000);
    this.at = t;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    this.droppedLines++;
    this.droppedBytes += n;
    return false;
};
/* The line saying what of kind was dropped since the last call, or null. */
Limiter.prototype.summary = function (us, kind) {
    if (!this.droppedLines) return null;
    var line = isoUs(us) + ' journal-keep: dropped ' + this.droppedLines + ' ' + kind + ' lines (' +
        Math.ceil(this.droppedBytes / 1024) + ' KiB) over the rate limit\n';
    this.droppedLines = this.droppedBytes = 0;
    return Buffer.from(line);
};

/* The files: dir/journal.log and its rotations .1 .. .<files-1>. */
function Ring(dir, opts) {
    var o = opts || {};
    this.dir = dir;
    this.files = o.files || FILES;
    this.fileMax = o.fileMax || FILE_MAX;
    this.size = null;
}
Ring.prototype.name = function (i) { return path.join(this.dir, FILE + (i ? '.' + i : '')); };
Ring.prototype.rotate = function () {
    for (var i = this.files - 1; i > 0; i--) {
        try { fs.renameSync(this.name(i - 1), this.name(i)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    this.size = 0;
};
/* Drops rotations past the cap, and rotates a file already past it. */
Ring.prototype.trim = function () {
    var self = this;
    fs.readdirSync(this.dir).forEach(function (n) {
        var m = /^journal\.log\.(\d+)$/.exec(n);
        if (m && Number(m[1]) >= self.files) fs.unlinkSync(path.join(self.dir, n));
    });
    try { this.size = fs.statSync(this.name(0)).size; } catch (e) { this.size = 0; }
    if (this.size > this.fileMax) this.rotate();
};
/* Appends lines (Buffers, each at most fileMax bytes), rotating between
 * lines so no file passes fileMax. */
Ring.prototype.append = function (lines) {
    if (this.size === null) this.trim();
    var batch = [], bytes = 0, self = this;
    function write() {
        if (!batch.length) return;
        var fd = fs.openSync(self.name(0), 'a', 0o660);
        try { fs.writeSync(fd, Buffer.concat(batch)); } finally { fs.closeSync(fd); }
        self.size += bytes;
        batch = [];
        bytes = 0;
    }
    lines.forEach(function (b) {
        if (self.size + bytes + b.length > self.fileMax) { write(); self.rotate(); }
        batch.push(b);
        bytes += b.length;
    });
    write();
};
/* The time (µs) of the newest line the files hold, or 0. */
Ring.prototype.newest = function () {
    for (var i = 0; i < this.files; i++) {
        var fd;
        try { fd = fs.openSync(this.name(i), 'r'); } catch (e) { continue; }
        try {
            var size = fs.fstatSync(fd).size, n = Math.min(size, 2 * LINE_MAX), b = Buffer.alloc(n);
            fs.readSync(fd, b, 0, n, size - n);
            var lines = b.toString('utf8').split('\n').filter(Boolean);
            for (var j = lines.length - 1; j >= 0; j--) {
                var m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{6})Z /.exec(lines[j]);
                if (m) return Date.parse(m[1] + 'Z') * 1000 + Number(m[2]);
            }
        } finally { fs.closeSync(fd); }
    }
    return 0;
};

/* This boot's start (µs), from /proc/stat; 0 when unknown. */
function bootUs() {
    try {
        var m = /^btime (\d+)$/m.exec(fs.readFileSync(process.env.WOC_PROC_STAT || '/proc/stat', 'utf8'));
        return m ? Number(m[1]) * 1e6 : 0;
    } catch (e) { return 0; }
}

function main() {
    var ring = new Ring(DIR), limit = { tool: new Limiter(RATE / 2), other: new Limiter(RATE / 2) };
    var pending = [], pendingBytes = 0, lastUs = 0, child = null, quitting = false, warned = '';
    function warn(msg) { if (msg !== warned) { warned = msg; console.error('journal-keep: ' + msg); } }
    try { ring.trim(); lastUs = ring.newest(); } catch (e) { warn(e.message); }
    if (lastUs < bootUs()) lastUs = 0;

    function flush() {
        ['tool', 'other'].forEach(function (k) {
            var s = limit[k].summary(Date.now() * 1000, k);
            if (s) pending.push(s);
        });
        if (!pending.length) return;
        var lines = pending;
        pending = [];
        pendingBytes = 0;
        try { ring.append(lines); warned = ''; } catch (e) { ring.size = null; warn('cannot write ' + DIR + ': ' + e.message); }
    }
    /* since: where this journalctl resumed, whose own line comes again */
    function take(entry, since) {
        var f = format(entry);
        if (!f || f.us <= since) return;
        lastUs = f.us;
        if (!limit[f.tool ? 'tool' : 'other'].take(f.line.length)) return;
        pending.push(f.line);
        pendingBytes += f.line.length;
        if (pendingBytes > PENDING_MAX) flush();
    }
    function follow() {
        if (quitting) return;
        var buf = '', since = lastUs;
        child = cp.spawn(JOURNALCTL, journalArgs(since), { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                var entry = null;
                try { entry = JSON.parse(line); } catch (e) { /* not an entry */ }
                if (entry) take(entry, since);
            }
            if (buf.length > 64 * LINE_MAX) buf = '';
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', function (d) { warn('journalctl: ' + d.trim().slice(0, 200)); });
        child.on('error', function (e) { warn('journalctl: ' + e.message); });
        child.on('close', function (code, signal) {
            child = null;
            if (quitting) return;
            warn('journalctl ended (' + (signal || code) + '); again in ' + RESPAWN_MS / 1000 + ' s');
            setTimeout(follow, RESPAWN_MS);
        });
    }
    var timer = setInterval(flush, FLUSH_MS);
    function quit() {
        quitting = true;
        clearInterval(timer);
        if (child) child.kill('SIGTERM');
        flush();
        process.exit(0);
    }
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    follow();
}

if (require.main === module) main();

module.exports = { journalArgs: journalArgs, format: format, Limiter: Limiter, Ring: Ring,
    FILES: FILES, FILE_MAX: FILE_MAX, LINE_MAX: LINE_MAX, RATE: RATE, UNITS: UNITS };
