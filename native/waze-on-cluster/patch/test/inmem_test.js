// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* The carplay patch in memory (inmem.js, PATCH.md "In memory"): the plan
 * and its overlay, the record, arming and disarming, the memory check, and
 * boot recovery counting armed starts and turning the patch off at the
 * threshold. The plan tests take carplay 22.28.3 (CARPLAY_BIN) and are
 * skipped without it. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const hu = require('./head_unit_env.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-inmem-'));
const T = path.join(dir, 'usr-bin-carplay');
Object.assign(process.env, {
    WOC_STATE_DIR: path.join(dir, 'var'), WOC_PRELOAD_DIR: path.join(dir, 'run'), WOC_CARPLAY: T,
    WOC_PRELOAD_LIB: path.join(dir, 'lib', 'libwocpatch.so'), WOC_PROC: path.join(dir, 'proc'), WOC_PASSWD: path.join(dir, 'passwd'),
    WOC_RECOVERY_STATE: path.join(dir, 'var', 'boot-recovery.json'), WOC_PATCH_SOCK: path.join(dir, 'shm', 'patch.sock'),
    WOC_REMOUNT_LOCK: path.join(dir, 'shm', 'remount.lock'),
});
['var', 'lib', 'proc', 'shm'].forEach((d) => fs.mkdirSync(path.join(dir, d)));
fs.writeFileSync(process.env.WOC_PRELOAD_LIB, 'lib');
fs.writeFileSync(process.env.WOC_PASSWD, 'root:x:0:0::/:/bin/sh\ncia_13002:x:13002:13002::/:/bin/false\n');
const inmem = require('../inmem.js');
const recovery = require('../recovery.js');

const CARPLAY_BIN = process.env.CARPLAY_BIN || '';
const tests = [];
function test(name, fn, needsBin) { tests.push({ name, fn, needsBin }); }
const P = inmem.paths('carplay');

function plan(args) {
    return new Promise((res, rej) => inmem.makePlan('carplay', ['--panel', 'high', '--coding', hu.CODING].concat(args || []), 60000, (e, r) => e ? rej(e) : res(r)));
}

test('a plan of the stock build: the record on trial, the overlay reads patched, the file untouched', async () => {
    fs.copyFileSync(CARPLAY_BIN, T);
    const before = fs.readFileSync(T), st = fs.statSync(T);
    const rec = await plan();
    assert(fs.readFileSync(T).equals(before) && fs.statSync(T).mtime.getTime() === st.mtime.getTime(), 'carplay not written');
    assert.strictEqual(rec.enabled, true);
    assert.strictEqual(rec.trial, true, 'a first patch is on trial');
    assert.strictEqual(inmem.kind('carplay'), 'unproven');
    assert.deepStrictEqual(rec.edits, ['variant', 'selfstart', 'res-mm', 'res-px', 'res-safe1', 'res-safe2', 'mapurl-1', 'mapurl-2', 'showui-1', 'showui-2']);
    const text = fs.readFileSync(P.plan, 'utf8');
    assert(/^wocplan 1\nbuild-id 5de62156575d737391ea42254e778a97dbbb51f8\n/.test(text) && /\nend 11\n$/.test(text));
    assert(text.indexOf('edit variant 2ba4f0 ecf2f7ff bcf2f7ff\n') > 0, 'Edit 1 at its PATCH.md site');
    const o = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'carplay_patch.js'), 'overlay', '--target', T, '--plan', P.plan], { encoding: 'utf8' });
    assert(/^variant:\s+PATCHED -> IC_HIGH/m.test(o) && /^selfstart:\s+SELF-START/m.test(o) && /^showui:\s+PATCHED/m.test(o) && /^overlay:\s+ok$/m.test(o), o);
}, true);

test('the plan of a patched file is refused; a changed file or plan is no longer described', async () => {
    const rec = inmem.readRecord('carplay');
    const buf = fs.readFileSync(T);
    buf[0x2ba4f0] = 0xbc;
    fs.writeFileSync(T + '.patched', buf);
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'carplay_patch.js'), 'plan', '--target', T + '.patched', '--panel', 'high', '--coding', hu.CODING, '--out', path.join(dir, 'x.plan')], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
    assert(/pristine build/.test(r.stderr), r.stderr);
    const t = new Date(Date.now() - 5000);
    fs.utimesSync(T, t, t);
    assert.strictEqual(inmem.current('carplay'), null, 'another mtime: not described');
    fs.copyFileSync(CARPLAY_BIN, T);
    await plan();
    fs.appendFileSync(P.plan, '#');
    assert.strictEqual(inmem.current('carplay'), null, 'another plan: not described');
    await plan();
    assert(inmem.current('carplay') && rec);
}, true);

test('a build outside the proven list is refused without --unproven, and unproven (not on trial) with it', async () => {
    const buf = fs.readFileSync(CARPLAY_BIN);
    const id = buf.indexOf(Buffer.from('5de62156575d737391ea42254e778a97dbbb51f8', 'hex'));
    buf[id] ^= 1;
    fs.writeFileSync(T, buf);
    await assert.rejects(plan(), (e) => /not a proven build/.test(e.refused || ''));
    const rec = await plan(['--unproven']);
    assert.strictEqual(rec.trial, false);
    assert.strictEqual(rec.proven, false);
    fs.copyFileSync(CARPLAY_BIN, T);
    await plan();
}, true);

test('proven carries over only for the same plan, on or turned off by the user, never after boot recovery', async () => {
    inmem.update('carplay', { proven: true, trial: false });
    let rec = await plan();
    assert.strictEqual(rec.proven, true, 'the same plan, on');
    inmem.disable('carplay', { by: 'user' });
    rec = await plan();
    assert.strictEqual(rec.proven, true, 'after Remove patch');
    inmem.disable('carplay', { by: 'recovery', fails: 2 });
    rec = await plan();
    assert.strictEqual(rec.proven, false);
    assert.strictEqual(rec.trial, true, 'after boot recovery: on trial again');
    inmem.update('carplay', { proven: true, trial: false });
    rec = await plan(['--res', '1280x564']);
    assert.strictEqual(rec.trial, true, 'another plan: on trial');
    await plan();
}, true);

test('arm: the plan, the result file and the env (the unit\'s preload first); again changes nothing; disarm', async () => {
    const a = inmem.arm('carplay', { preload: '/usr/lib/libschedconfig.so.1', user: 'cia_13002' });
    assert.deepStrictEqual(a, { armed: true });
    const env = fs.readFileSync(P.env, 'utf8');
    assert.strictEqual(env, 'LD_PRELOAD=/usr/lib/libschedconfig.so.1 ' + process.env.WOC_PRELOAD_LIB + '\nWOC_PATCH_PLAN=' + P.runPlan + '\nWOC_PATCH_RESULT=' + P.result + '\n');
    assert(fs.readFileSync(P.runPlan).equals(fs.readFileSync(P.plan)));
    assert.strictEqual(fs.readFileSync(P.result, 'utf8'), '');
    fs.writeFileSync(P.result, '{"v":1,"pid":7,"applied":true}\n');
    assert.strictEqual(inmem.arm('carplay', { preload: '/usr/lib/libschedconfig.so.1', user: 'cia_13002' }).already, true);
    assert.strictEqual(inmem.result('carplay').pid, 7, 'a run\'s result is kept');
    assert(inmem.disarm('carplay') && !fs.existsSync(P.env) && !fs.existsSync(P.runPlan));
    assert.strictEqual(inmem.armed('carplay'), false);
}, true);

test('arm refuses, and leaves nothing armed: no enabled record, no library, no user', async () => {
    fs.renameSync(process.env.WOC_PRELOAD_LIB, process.env.WOC_PRELOAD_LIB + '.x');
    let a = inmem.arm('carplay', { preload: '', user: 'cia_13002' });
    assert(!a.armed && /missing/.test(a.why) && !fs.existsSync(P.env));
    fs.renameSync(process.env.WOC_PRELOAD_LIB + '.x', process.env.WOC_PRELOAD_LIB);
    a = inmem.arm('carplay', { preload: '', user: 'nobody' });
    assert(!a.armed && !fs.existsSync(P.env));
    inmem.disable('carplay', { by: 'user' });
    a = inmem.arm('carplay', { preload: '', user: 'cia_13002' });
    assert(!a.armed && !fs.existsSync(P.env));
    await plan();
}, true);

test('the memory check reads the plan\'s sites at the base of the target\'s mapping', () => {
    const pid = '4242', pd = path.join(dir, 'proc', pid);
    fs.mkdirSync(pd, { recursive: true });
    const ino = fs.statSync(T).ino, base = 0x1000;
    fs.writeFileSync(path.join(pd, 'maps'), '00000800-00000900 r--p 00000000 00:01 1 /lib/other.so\n' +
        base.toString(16).padStart(8, '0') + '-00400000 r-xp 00000000 fd:00 ' + ino + ' /usr/bin/carplay\n');
    const mem = path.join(pd, 'mem'), edits = require('../carplay_patch.js').parsePlan(fs.readFileSync(P.plan, 'utf8')).edits;
    const fd = fs.openSync(mem, 'w');
    edits.forEach((e) => fs.writeSync(fd, e.stock, 0, e.stock.length, base + e.va));
    fs.closeSync(fd);
    assert.strictEqual(inmem.memState('carplay', 4242), 'stock');
    const fd2 = fs.openSync(mem, 'r+');
    edits.forEach((e) => fs.writeSync(fd2, e.patched, 0, e.patched.length, base + e.va));
    assert.strictEqual(inmem.memState('carplay', 4242), 'patched');
    fs.writeSync(fd2, edits[0].stock, 0, edits[0].stock.length, base + edits[0].va);
    fs.closeSync(fd2);
    assert.strictEqual(inmem.memState('carplay', 4242), 'mixed');
    assert.strictEqual(inmem.memState('carplay', 4243), null, 'no such process');
}, true);

function rec(bootId, extra) {
    const logs = [];
    const r = new recovery.Recovery(Object.assign({ target: recovery.TARGETS.carplay, bootId: bootId, log: (l) => logs.push(l),
        arm: () => inmem.arm('carplay', { preload: '', user: 'cia_13002' }), repairModes: (cb) => cb(null, 0) }, extra || {}));
    r.logs = logs;
    return r;
}
function decide(r) { return new Promise((res) => r._decide(res)); }
function state() { return JSON.parse(fs.readFileSync(process.env.WOC_RECOVERY_STATE, 'utf8')); }

test('boot recovery arms an enabled patch, counts a crash of an armed start and turns a patch on trial off at 1, writing nothing to the file', async () => {
    try { fs.unlinkSync(process.env.WOC_RECOVERY_STATE); } catch (e) {}
    const before = fs.statSync(T);
    let r = await decide(rec('boot-1'));
    assert.strictEqual(r.action, 'armed');
    assert.strictEqual(r.inmem, true);
    assert(inmem.armed('carplay'), 'the next start is armed');
    assert.strictEqual(state().arm.inmem, true);
    /* the armed start crashed: the watcher's count */
    const st = state();
    st.arm.crashes = 1;
    fs.writeFileSync(process.env.WOC_RECOVERY_STATE, JSON.stringify(st));
    inmem.disarm('carplay');   /* /run is empty at the next boot */
    r = await decide(rec('boot-2'));
    assert.strictEqual(r.action, 'restored');
    assert(!fs.existsSync(P.env), 'not armed');
    const rc = inmem.readRecord('carplay');
    assert.strictEqual(rc.enabled, false);
    assert.strictEqual(rc.by, 'recovery');
    assert.strictEqual(fs.statSync(T).mtime.getTime(), before.mtime.getTime(), 'carplay untouched');
    r = await decide(rec('boot-3'));
    assert.strictEqual(r.action, 'idle');
    assert(!fs.existsSync(P.env), 'the next boot runs stock too');
    await plan();
}, true);

test('a proven patch is turned off at 2; a healthy start between clears the count', async () => {
    try { fs.unlinkSync(process.env.WOC_RECOVERY_STATE); } catch (e) {}
    inmem.update('carplay', { proven: true, trial: false });
    assert.strictEqual(inmem.kind('carplay'), 'proven');
    let r = await decide(rec('p-1'));
    assert.strictEqual(r.action, 'armed');
    function crashed() { const st = state(); st.arm.crashes = 1; fs.writeFileSync(process.env.WOC_RECOVERY_STATE, JSON.stringify(st)); }
    crashed();
    r = await decide(rec('p-2'));
    assert.strictEqual(r.action, 'armed', 'one crash of a proven patch');
    assert.strictEqual(r.fails, 1);
    const st = state(); st.arm.confirmed = true; st.arm.ran = true; fs.writeFileSync(process.env.WOC_RECOVERY_STATE, JSON.stringify(st));
    r = await decide(rec('p-3'));
    assert.strictEqual(r.fails, 0, 'a healthy start clears it');
    crashed();
    r = await decide(rec('p-4'));
    crashed();
    r = await decide(rec('p-5'));
    assert.strictEqual(r.action, 'restored');
    assert.strictEqual(inmem.readRecord('carplay').fails, 2);
    await plan();
}, true);

test('in memory, a restart for a crash counts even after a healthy run (a reset that beat the shutdown mark)', () => {
    const c = { fails: 0, unknown: 0 };
    assert.strictEqual(recovery.tally(c, { confirmed: true, inmem: true }, { crash: true }).fails, 1);
    assert.strictEqual(recovery.tally(c, { confirmed: true, inmem: true }, { crash: false }).fails, 0);
    assert.strictEqual(recovery.tally(c, { confirmed: true }, { crash: true }).fails, 0, 'the file patch keeps its rule');
});

test('a plan is never armed for another file: a firmware update that replaced carplay', async () => {
    fs.unlinkSync(T);
    fs.copyFileSync(CARPLAY_BIN, T);
    assert.strictEqual(inmem.kind('carplay'), null);
    const r = await decide(rec('fw-1'));
    assert.strictEqual(r.action, 'idle');
    assert(!fs.existsSync(P.env));
}, true);

(async () => {
    let failed = 0, n = 0;
    for (const t of tests) {
        if (t.needsBin && !CARPLAY_BIN) { console.log('ok   ' + t.name + '\n     (skipped: CARPLAY_BIN not set)'); continue; }
        n++;
        try { await t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
    }
    cp.execFileSync('rm', ['-rf', dir]);
    console.log((n - failed) + '/' + n + ' passed');
    process.exit(failed ? 1 : 0);
})();
