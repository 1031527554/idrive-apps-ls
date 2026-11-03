// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* journal_keep.js: the files' caps, the rate limit that keeps 10 minutes in
 * them under a flood, the lines it writes, and a restart resuming after the
 * newest line with a fake journalctl. */
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
var jk = require('../journal_keep.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wjk-'));
function fresh(name) { var d = path.join(tmp, name); fs.mkdirSync(d); return d; }
function files(dir) { return fs.readdirSync(dir).filter(function (n) { return /^journal\.log/.test(n); }).sort(); }
function line(n, len) { var s = 'line ' + n + ' '; return Buffer.from(s + 'x'.repeat(len - s.length - 1) + '\n'); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(what, fn) {
    for (var i = 0; i < 300; i++) { if (fn()) return; await delay(20); }
    throw new Error('timed out waiting for ' + what);
}

/* rotation: never more than `files` files, none past fileMax, oldest dropped */
(function () {
    var dir = fresh('caps'), ring = new jk.Ring(dir, { files: 4, fileMax: 1000 });
    for (var i = 0; i < 200; i++) ring.append([line(i, 90)]);
    assert.deepStrictEqual(files(dir), ['journal.log', 'journal.log.1', 'journal.log.2', 'journal.log.3']);
    files(dir).forEach(function (n) { assert(fs.statSync(path.join(dir, n)).size <= 1000, n); });
    var all = [3, 2, 1, 0].map(function (i) { return fs.readFileSync(ring.name(i), 'utf8'); }).join('');
    var nums = all.split('\n').filter(Boolean).map(function (l) { return Number(l.split(' ')[1]); });
    assert.strictEqual(nums[nums.length - 1], 199, 'the newest line is last in journal.log');
    nums.forEach(function (n, k) { if (k) assert.strictEqual(n, nums[k - 1] + 1, 'contiguous, oldest first'); });
    /* a batch rotates between its lines */
    ring.append([200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211].map(function (n) { return line(n, 90); }));
    files(dir).forEach(function (n) { assert(fs.statSync(path.join(dir, n)).size <= 1000, n); });
    /* a stray rotation past the cap is dropped and an oversize file rotated */
    fs.writeFileSync(path.join(dir, 'journal.log.7'), 'old\n');
    fs.writeFileSync(path.join(dir, 'journal.log'), 'y'.repeat(1500));
    var again = new jk.Ring(dir, { files: 4, fileMax: 1000 });
    again.append([line(300, 90)]);
    assert.deepStrictEqual(files(dir), ['journal.log', 'journal.log.1', 'journal.log.2', 'journal.log.3']);
    assert.strictEqual(fs.statSync(again.name(1)).size, 1500, 'the oversize file moved to .1, not written to');
    console.log('ok   rotation: at most FILES files, none past FILE_MAX, oldest dropped, stray rotations removed');
})();

/* The shipped caps under a flood: lines of LINE_MAX from both kinds, each
 * ten times its rate, for half an hour. The files stay within 10 files and
 * 4 MB and keep every line let through in the last 10 minutes. */
(function () {
    var dir = fresh('flood'), t = 0, now = function () { return t; };
    var ring = new jk.Ring(dir), limits = [new jk.Limiter(jk.RATE / 2, now), new jk.Limiter(jk.RATE / 2, now)];
    assert(jk.FILES <= 10 && jk.FILES * jk.FILE_MAX <= 4e6, 'caps: 10 files, 4 MB');
    var kept = [], perStep = Math.ceil(10 * jk.RATE / 2 / jk.LINE_MAX / 60), n = 0;
    for (t = 0; t <= 30 * 60000; t += 2000) {
        var batch = [];
        limits.forEach(function (limiter) {
            for (var k = 0; k < 2 * perStep; k++, n++) {
                var b = line(n, jk.LINE_MAX);
                if (limiter.take(b.length)) { batch.push(b); kept.push({ n: n, t: t }); }
            }
        });
        limits.forEach(function (limiter) {
            var s = limiter.summary(t * 1000, 'some');
            if (s) batch.push(s);
        });
        ring.append(batch);
    }
    assert(files(dir).length <= jk.FILES);
    var total = files(dir).reduce(function (a, f) { return a + fs.statSync(path.join(dir, f)).size; }, 0);
    assert(total <= jk.FILES * jk.FILE_MAX, 'total ' + total);
    var held = {};
    files(dir).forEach(function (f) {
        fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach(function (l) {
            var m = /^line (\d+) /.exec(l);
            if (m) held[m[1]] = true;
        });
    });
    var recent = kept.filter(function (x) { return x.t >= 20 * 60000; });
    assert(recent.length > 0 && kept.length < n, 'the flood was limited');
    recent.forEach(function (x) { assert(held[x.n], 'line ' + x.n + ' of the last 10 minutes is held'); });
    assert(/dropped \d+ some lines \(\d+ KiB\) over the rate limit/.test(fs.readFileSync(path.join(dir, 'journal.log'), 'utf8')));
    console.log('ok   a 30-minute flood at 10x the rate: ' + files(dir).length + ' files, ' + total + ' B, the last 10 minutes held');
})();

/* the line format and journalctl's arguments */
(function () {
    var us = Date.UTC(2026, 10, 3, 6, 58, 54) * 1000 + 365447;
    assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: 'cluster-render.service',
        SYSLOG_IDENTIFIER: 'cluster-render', _PID: '1152', MESSAGE: 'two\nlines' }).line.toString(),
        '2026-11-03T06:58:54.365447Z cluster-render.service cluster-render[1152]: two lines\n');
    var k = jk.format({ __REALTIME_TIMESTAMP: String(us), _TRANSPORT: 'kernel', SYSLOG_IDENTIFIER: 'kernel', MESSAGE: [104, 105] });
    assert.strictEqual(k.line.toString(), '2026-11-03T06:58:54.365447Z kernel: hi\n');
    assert.strictEqual(k.tool, false);
    ['waze-on-cluster.service', 'waze-on-cluster-logs.service', 'cluster-render.service'].forEach(function (u) {
        assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: u, MESSAGE: 'x' }).tool, true, u);
        assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: 'init.scope', UNIT: u, MESSAGE: 'x' }).tool, true, u);
    });
    ['carplay.service', 'recmgr.service', 'crashhandler.service'].forEach(function (u) {
        assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: u, MESSAGE: 'x' }).tool, false, u);
    });
    assert.strictEqual(jk.format({ __REALTIME_TIMESTAMP: String(us), _SYSTEMD_UNIT: 'init.scope', UNIT: 'carplay.service',
        SYSLOG_IDENTIFIER: 'systemd', _PID: '1', MESSAGE: 'Started carplay.' }).line.toString(),
        '2026-11-03T06:58:54.365447Z carplay.service systemd[1]: Started carplay.\n');
    var long = jk.format({ __REALTIME_TIMESTAMP: String(us), MESSAGE: 'z'.repeat(5000) }).line;
    assert.strictEqual(long.length, jk.LINE_MAX);
    assert.strictEqual(jk.format({ MESSAGE: 'no time' }), null);

    var args = jk.journalArgs(us);
    assert(args.indexOf('--since=@1793689134.365447') >= 0, args.join(' '));
    var groups = args.slice(args.indexOf('_SYSTEMD_UNIT=' + jk.UNITS[0])).join(' ').split(' + ');
    assert.strictEqual(groups.length, 3, 'three alternatives: the units, systemd about them, the kernel');
    assert(/^(_SYSTEMD_UNIT=\S+ ?)+$/.test(groups[0]));
    assert(/^_PID=1( UNIT=\S+)+$/.test(groups[1]) && groups[1].indexOf('UNIT=waze-on-cluster-logs.socket') > 0);
    assert.strictEqual(groups[2], '_TRANSPORT=kernel');
    ['waze-on-cluster.service', 'waze-on-cluster-patchd.service', 'waze-on-cluster-boot.service',
        'waze-on-cluster-recovery.service', 'cluster-render.service', 'carplay.service', 'recmgr.service',
        'crashhandler.service'].forEach(function (u) { assert(jk.UNITS.indexOf(u) >= 0, u); });
    assert(jk.journalArgs(0).every(function (a) { return a.indexOf('--since') !== 0; }), 'no --since without a line');
    console.log('ok   lines: time, unit, identifier[pid]; kernel; systemd\'s about a unit; LINE_MAX; three match groups');
})();

/* the service: writes what journalctl gives, resumes after the newest line */
(async function () {
    var dir = fresh('run'), argsLog = path.join(tmp, 'args'), fake = path.join(tmp, 'journalctl');
    var stat = path.join(tmp, 'stat');
    fs.writeFileSync(stat, 'cpu 1 2 3\nbtime 1000\n');
    var t0 = Date.UTC(2026, 10, 3, 7) * 1000;
    var entries = [1, 2, 3].map(function (i) {
        return JSON.stringify({ __REALTIME_TIMESTAMP: String(t0 + i), _SYSTEMD_UNIT: 'waze-on-cluster.service',
            SYSLOG_IDENTIFIER: 'waze-on-cluster', _PID: '7', MESSAGE: 'm' + i });
    });
    fs.writeFileSync(path.join(tmp, 'entries'), entries.join('\n') + '\n');
    fs.writeFileSync(fake, '#!/bin/sh\necho "$@" >> ' + argsLog + '\ncat ' + path.join(tmp, 'entries') + '\nexec sleep 30\n');
    fs.chmodSync(fake, 0o755);
    var env = Object.assign({}, process.env, { WOC_JOURNAL_DIR: dir, WOC_JOURNALCTL: fake, WOC_JOURNAL_FLUSH_MS: '50',
        WOC_PROC_STAT: stat });
    function run() { return cp.spawn(process.execPath, [path.join(__dirname, '..', 'journal_keep.js')], { env: env, stdio: 'ignore' }); }
    function lines() { try { return fs.readFileSync(path.join(dir, 'journal.log'), 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } }
    async function stop(c) { var done = new Promise(function (r) { c.on('exit', r); }); c.kill('SIGTERM'); return done; }

    var c = run();
    await until('three lines', function () { return lines().length === 3; });
    assert(/^2026-11-03T07:00:00\.000001Z waze-on-cluster\.service waze-on-cluster\[7\]: m1$/.test(lines()[0]), lines()[0]);
    assert.strictEqual(await stop(c), 0, 'SIGTERM: a clean exit');
    assert(fs.readFileSync(argsLog, 'utf8').indexOf('--since') < 0, 'the first start reads the whole boot');

    /* the same entries again, with a fourth: only the fourth is new */
    entries.push(JSON.stringify({ __REALTIME_TIMESTAMP: String(t0 + 4), _TRANSPORT: 'kernel', MESSAGE: 'k4' }));
    fs.writeFileSync(path.join(tmp, 'entries'), entries.join('\n') + '\n');
    c = run();
    await until('four lines', function () { return lines().length === 4; });
    await delay(200);
    assert.strictEqual(lines().length, 4, 'no line written twice');
    assert(/--since=@\d+\.000003/.test(fs.readFileSync(argsLog, 'utf8').split('\n')[1]), 'resumed after the newest line');
    await stop(c);

    /* a newest line from before this boot: the whole boot again */
    fs.writeFileSync(stat, 'btime ' + (Math.floor(t0 / 1e6) + 3600) + '\n');
    c = run();
    await until('started', function () { return fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean).length === 3; });
    assert(fs.readFileSync(argsLog, 'utf8').split('\n')[2].indexOf('--since') < 0, 'a previous boot\'s line is not resumed from');
    await stop(c);
    console.log('ok   the service writes journalctl\'s entries, resumes after its newest line, and not across boots');

    /* a kernel flood past its share: the tools' lines all kept, the kernel's cut and counted */
    var flood = [], kdir = fresh('fair');
    for (var i = 1; i <= 2000; i++) {
        flood.push(JSON.stringify({ __REALTIME_TIMESTAMP: String(t0 + 10 * i), _TRANSPORT: 'kernel', MESSAGE: 'k'.repeat(900) }));
        if (i % 100 === 0) flood.push(JSON.stringify({ __REALTIME_TIMESTAMP: String(t0 + 10 * i + 1),
            _SYSTEMD_UNIT: 'waze-on-cluster.service', SYSLOG_IDENTIFIER: 'waze-on-cluster', _PID: '7', MESSAGE: 'tool ' + i }));
    }
    fs.writeFileSync(path.join(tmp, 'entries'), flood.join('\n') + '\n');
    fs.writeFileSync(stat, 'btime 1000\n');
    env.WOC_JOURNAL_DIR = kdir;
    c = run();
    var all = function () { return fs.readdirSync(kdir).map(function (f) { return fs.readFileSync(path.join(kdir, f), 'utf8'); }).join(''); };
    await until('the flood summarised', function () { return /dropped \d+ other lines/.test(all()); });
    await stop(c);
    assert.strictEqual((all().match(/ tool \d+$/mg) || []).length, 20, 'every tool line kept');
    assert(!/dropped \d+ tool lines/.test(all()));
    var kernel = (all().match(/ kernel: k+$/mg) || []).length;
    assert(kernel > 0 && kernel < 2000, kernel + ' kernel lines kept');
    console.log('ok   a kernel flood past its share is cut and counted; every tool line is kept');
    fs.rmSync ? fs.rmSync(tmp, { recursive: true, force: true }) : cp.execFileSync('rm', ['-rf', tmp]);
    console.log('journal_keep: all passed');
})().catch(function (e) { console.error('FAIL', e && e.stack); process.exit(1); });
