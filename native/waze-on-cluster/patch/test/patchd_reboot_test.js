#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd's Restart head unit against a fake nsm_control: the request it
 * sends (`--requestRestart 7 --normal`), a restart NSM takes, nsm_control's
 * "[Error. <why>]" on stdout with exit 0, a non-zero exit, and a unit that
 * stays up past the wait. A failed request ends the restart with its reason
 * and lets the next request through; one NSM took keeps the 10-minute
 * limit. No firmware: carplay is a stand-in file, aapd absent.
 *
 *   node patchd_reboot_test.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var fails = 0, children = [], dirs = [];
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    dirs.forEach(function (d) { try { cp.execFileSync('rm', ['-rf', d]); } catch (e) {} });
});

/* A unit with a pending CarPlay change; nsm_control answers as `mode` says. */
function unit(waitMs) {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rb-'));
    dirs.push(d);
    ['shm', 'var', 'bin', 'units'].forEach(function (x) { fs.mkdirSync(path.join(d, x)); });
    var t = { d: d, calls: path.join(d, 'calls'), mode: path.join(d, 'mode'), sock: path.join(d, 'shm', 'patch.sock') };
    fs.writeFileSync(t.calls, '');
    fs.writeFileSync(path.join(d, 'carplay'), 'not a carplay build\n');
    fs.writeFileSync(path.join(d, 'mounts'), '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(path.join(d, 'shm', 'activation-pending'), JSON.stringify({ action: 'apply' }) + '\n');
    var nsm = path.join(d, 'bin', 'nsm_control');
    fs.writeFileSync(nsm, '#!/bin/sh\necho "$*" >> "' + t.calls + '"\ncase "$(cat "' + t.mode + '")" in\n' +
        'error) echo "[Error. ProxyLifecycleControl not available!]";;\n' +
        'exit) echo "nsm_control: cannot reach NSM" >&2; exit 3;;\n' +
        '*) echo "[Info. request sent]";;\nesac\n');
    fs.chmodSync(nsm, 0o755);
    t.env = Object.assign({}, process.env, {
        PATH: path.join(d, 'bin') + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: t.sock, WOC_CARPLAY: path.join(d, 'carplay'), WOC_AAPD: path.join(d, 'none'),
        WOC_AAPD_CONF: path.join(d, 'none'), WOC_CODING: path.join(d, 'none'), WOC_PROC_MOUNTS: path.join(d, 'mounts'),
        WOC_MOUNT: '/usr/bin/true', WOC_UNIT_DIRS: path.join(d, 'units'), WOC_CAPTURE_SOCK: path.join(d, 'none.sock'),
        WOC_DLT_RECEIVE: path.join(d, 'none'), WOC_DLT_RETRY_MS: '600000', WOC_REMOUNT_LOCK: path.join(d, 'shm', 'remount.lock'),
        WOC_STATE_DIR: path.join(d, 'var'), WOC_REBOOT_CMD: nsm + ' --requestRestart 7 --normal',
        WOC_REBOOT_WAIT_MS: String(waitMs || 600000)
    });
    return t;
}

function daemon(t) {
    var c = cp.spawn(process.execPath, [PATCHD], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(c);
    var log = '';
    c.stdout.on('data', function (b) { log += b; });
    c.stderr.on('data', function (b) { log += b; });
    return new Promise(function (resolve, reject) {
        (function wait(n) {
            if (!fs.existsSync(t.sock)) {
                if (n > 200) { reject(new Error('patchd did not listen: ' + log)); return; }
                setTimeout(function () { wait(n + 1); }, 50);
                return;
            }
            var s = net.connect(t.sock), buf = '', waiters = [];
            var api = {
                send: function (o) { s.write(JSON.stringify(o) + '\n'); },
                next: function (pred, ms) {
                    return new Promise(function (res, rej) {
                        var tm = setTimeout(function () { rej(new Error('timeout; log: ' + log.slice(-800))); }, ms || 20000);
                        waiters.push({ pred: pred, res: function (m) { clearTimeout(tm); res(m); } });
                    });
                }
            };
            s.setEncoding('utf8');
            s.on('data', function (chunk) {
                buf += chunk;
                var i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    var m = JSON.parse(buf.slice(0, i));
                    buf = buf.slice(i + 1);
                    waiters = waiters.filter(function (w) { if (w.pred(m)) { w.res(m); return false; } return true; });
                }
            });
            s.on('connect', function () { resolve(api); });
        })(0);
    });
}

function calls(t) { return fs.readFileSync(t.calls, 'utf8').split('\n').filter(Boolean); }
function reply(m) { return m.ev === 'reboot-reply'; }
function refused(m) { return m.ev === 'reboot-reply' && m.ok === false; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
    var t = unit();
    var p = await daemon(t);

    fs.writeFileSync(t.mode, 'error');
    p.send({ cmd: 'reboot' });
    var first = await p.next(reply);
    var st = p.next(function (m) { return m.ev === 'status' && m.state === 'error'; });
    var rb = await p.next(refused);
    st = await st;
    ok('the request is NSM\'s normal restart', first.ok === true && calls(t)[0] === '--requestRestart 7 --normal', calls(t).join('; '));
    ok('"[Error. …]" with exit 0 ends the restart with its reason', rb.reason === 'ProxyLifecycleControl not available!' &&
        /ProxyLifecycleControl/.test(st.reason) && st.carplay === 'deferred', JSON.stringify([rb, st]));

    fs.writeFileSync(t.mode, 'exit');
    p.send({ cmd: 'reboot' });
    first = await p.next(reply);
    rb = await p.next(refused);
    ok('a failed request is no restart: the next one runs; a non-zero exit ends it with stderr', first.ok === true &&
        rb.reason === 'nsm_control: cannot reach NSM' && calls(t).length === 2, JSON.stringify([first, rb]));

    fs.writeFileSync(t.mode, 'ok');
    p.send({ cmd: 'reboot' });
    first = await p.next(reply);
    await sleep(300);
    p.send({ cmd: 'reboot' });
    rb = await p.next(reply);
    ok('a restart NSM took: under way, a second request refused', first.ok === true && rb.ok === false &&
        /already in progress/.test(rb.reason) && calls(t).length === 3, JSON.stringify([first, rb]));

    var u = unit(300);
    fs.writeFileSync(u.mode, 'ok');
    var q = await daemon(u);
    q.send({ cmd: 'reboot' });
    first = await q.next(reply);
    rb = await q.next(refused, 5000);
    q.send({ cmd: 'reboot' });
    var again = await q.next(reply);
    ok('a unit still up after the wait: the restart ends, and its request still counts', first.ok === true &&
        rb.reason === 'the head unit did not restart' && again.ok === false && /possible again in \d+ min/.test(again.reason),
        JSON.stringify([first, rb, again]));

    process.stdout.write(fails ? fails + ' failed\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
}

main().catch(function (e) { process.stdout.write('FAIL ' + (e && e.stack) + '\n'); process.exit(1); });
