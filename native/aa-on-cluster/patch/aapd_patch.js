#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
// Copyright (C) 2026 mlurker@gmail.com
/* aapd_patch.js — three reversible edits to the Android Auto Projected Daemon
 * (/usr/bin/aapd) that ungate the instrument-cluster ("alternate" / second)
 * video screen AND make aapd request it itself, so Google Maps renders its
 * cluster map (PATCH.md).
 *
 *   gate       one immediate byte in aapd::app::Application's second-video
 *              decision (secondVideoEnabled, the function that feeds the
 *              alternate-screen config, the ProjectionBridge and the Cinemo
 *              display type). It reads
 *                  return featureFlag && (KombiVariant <= 1);
 *              as `cmp dword [rbx+0x21c], 1 ; setbe al`. The head unit's
 *              KI_KOMBI_VARIANT coding maps, via aapd's codingToInternal, to
 *              an internal KombiVariant: raw 9->0, 10->1, 1..8 and 11->2,
 *              0->3. Cars whose cluster is a KOMBI4 "high" variant code to
 *              raw 7 -> KombiVariant 2, so `2 <= 1` is false and the cluster
 *              screen is gated off — the same reason CarPlay needed its
 *              variant patch. Raising the compare immediate from 1 to 2
 *              (`KombiVariant <= 2`) admits that class; KombiVariant 3 (raw 0
 *              / no cluster) stays off. The coding is left untouched, so the
 *              cluster hardware keeps describing itself correctly.
 *   selfstart  two edits in AlternateDisplays, the class that offers the
 *              cluster video to the phone once it is ready
 *              (onAlternateVideoReady) and then only subscribes and WAITS for
 *              a ProjectedModeRequestStreamCommand from the car's native
 *              navigation/HMI stack (subscribeEvents: "Subscribing to
 *              StreamCommandChanged") before calling requestStream(). On this
 *              build that command is never sent — confirmed live: with the
 *              gate patch alone, DLT shows onAlternateVideoReady and
 *              subscribeEvents fire, Cinemo navigation status reaches ACTIVE,
 *              but requestStream() is never called and no video reaches AVB
 *              stream 15 — the same stall carplay_patch.js's "selfstart" edit
 *              fixes for CarPlay (NavController never forwards the command
 *              there either).
 *                - call: onNewNavigationStatus()'s shared tail calls
 *                  setNaviStreamStatus(this, status) to tell the nav stack a
 *                  stream is available/unavailable, but never requests one.
 *                  Retargeting that `call` to requestStream(this) (same
 *                  `this` in rdi; the extra status-pointer argument is simply
 *                  unused by requestStream, which is ABI-safe) makes aapd ask
 *                  for the stream itself as soon as navigation goes ACTIVE.
 *                  requestStream() still calls setNaviStreamStatus(STREAMING)
 *                  from its own tail, so the nav stack is still notified.
 *                - guard: requestStream()'s own entry only proceeds past
 *                  `cmp dword [rbx+0x44], 2 ; je <real work>` when a prior
 *                  StreamCommandChanged event set that field to 2 — which,
 *                  per the same stall, never happens. Changing the `je` to an
 *                  unconditional `jmp` (same target, 1 byte longer; padded
 *                  with a NOP so nothing after it shifts) makes it proceed
 *                  whenever not already streaming (`[rbx+0x38] != 2`, left
 *                  untouched), independent of that field.
 *              Both edits are needed together: `call` alone reaches a
 *              requestStream() that still no-ops on the unsatisfied guard;
 *              `guard` alone removes a check nothing calls past.
 *
 *   size       the cluster's screen size for that same KombiVariant 2.
 *              loadKombiDisplayDefinition() turns KombiVariant into the
 *              screen size it looks up in /etc/aapd.conf (KOMBI_DISPLAY
 *              DIMENSIONS and CODEC_SUPPORTED): 0 -> 12.3, 1 -> 10.25, any
 *              other -> 0.0, and with 0.0 it uses built-in defaults instead
 *              of aapd.conf (an 800x480 stream whose UI is its top 800x300).
 *              Its fall-through for other variants sits in 16 bytes of which
 *              10 are alignment padding: the edit puts `cmp eax,2 ; je
 *              <12.3>` in front of the stock `pxor xmm0,xmm0 ; jmp <return>`,
 *              so KombiVariant 2 reads 12.3 (its KOMBI4 high cluster is the
 *              12.3" one) and every other variant is unchanged.
 *
 * Node 8 on the unit, no dependencies. Each edit is reversible from a
 * verified full backup; the original build is pinned by SHA-256 and every
 * edit region is validated by its anchor bytes on both sides, so the script
 * refuses an unrecognised build. The change takes effect the next time aapd
 * starts. Never stop or restart aapd by hand: unless recmgr loaded an aapd
 * entry at this boot, its death power-cycles the head unit (the Store install
 * adds that entry, and the change then waits for the next head-unit start).
 *
 *   aapd_patch.js status [--target <file>]
 *   aapd_patch.js apply  [--target <file>] [--yes] [--gate-only]
 *   aapd_patch.js verify [--target <file>]
 *   aapd_patch.js revert [--target <file>] [--yes] [--force] [--drop-backup]
 *
 * Default target /usr/bin/aapd. Edits the file by atomic rename, not the
 * running process, which keeps the old binary until aapd next starts.
 */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var path = require('path');

/* The one build this patch is proven against: aapd 22.39.3 as shipped on MGU
 * P18_23w44.2-1-3. */
var KNOWN = {
    version: 'aapd 22.39.3+gitrAUTOINC+d5a1db18c4-r0',
    size: 7367952,
    sha256_original: '6880f54c3abba40c1368f2bf254c77bd4a169323c0d4cab8f9662a7c912dcf89',

    /* gate: `cmp dword [rbx+0x21c], imm8 ; setbe al` in secondVideoEnabled().
     * The 6-byte cmp prefix (opcode 83 /7, modrm for [rbx+disp32], disp32 0x21c)
     * is fixed; the 7th byte is the compare immediate — 0x01 original
     * (KombiVariant <= 1), 0x02 patched (KombiVariant <= 2). Anchors on both
     * sides pin the offset: before it the call through the feature-flag vtable
     * slot and its `test al,al ; je`, after it the `setbe al` and the stack
     * canary load. */
    gate_offset: 0x998bd,
    gate_prefix: '83bb1c020000',     /* cmp dword [rbx+0x21c], imm8 */
    gate_imm_original: 0x01,         /* KombiVariant <= 1 (cluster gated off for variant 7) */
    gate_imm_patched: 0x02,          /* KombiVariant <= 2 (cluster enabled) */
    gate_anchor_before: 'ff928000000084c0740a', /* call [rdx+0x80] ; test al,al ; je (ends at gate_offset) */
    gate_anchor_after: '0f96c0488b4c240864',     /* setbe al ; mov rcx,[rsp+8] ; fs (starts at gate_offset+7) */

    /* selfstart/call: a 5-byte `call rel32` in onNewNavigationStatus's shared
     * tail, retargeted from setNaviStreamStatus to requestStream (same `this`
     * in rdi; requestStream takes one arg, so the extra rsi is unused). */
    sc_offset: 0x1d43eb,
    sc_original: 'e800f8ffff',   /* call 0x1d3bf0 (setNaviStreamStatus) */
    sc_patched: 'e840fbffff',    /* call 0x1d3f30 (requestStream) */
    sc_anchor_before: '4889442410', /* mov [rsp+0x10],rax, ends at sc_offset */
    sc_anchor_after: '488b442428', /* mov rax,[rsp+0x28], starts at sc_offset+5 */

    /* selfstart/guard: requestStream()'s entry check on the StreamCommandChanged
     * readiness field, widened from `je` to an unconditional `jmp` (same
     * target, one byte longer, NOP-padded to the same 6-byte length so
     * nothing after it moves). */
    sg_offset: 0x1d3f5d,
    sg_original: '0f848d000000',     /* je 0x1d3ff0 */
    sg_patched: 'e98e00000090',      /* jmp 0x1d3ff0 ; nop */
    sg_anchor_before: '837b4402',    /* cmp [rbx+0x44],2, ends at sg_offset */
    sg_anchor_after: 'e8a805ebff',   /* call 0x84510, starts at sg_offset+6 */

    /* size: the fall-through of the KombiVariant -> screen size helper
     * (0x15b400; its one caller is loadKombiDisplayDefinition), reached with
     * the variant in eax for every variant but 0 and 1. */
    ks_offset: 0x15b440,
    ks_original: '660fefc0ebe1662e0f1f840000000000',  /* pxor xmm0,xmm0 ; jmp 0x15b427 ; nopw (padding) */
    ks_patched: '83f802740b660fefc0ebdc0f1f440000',   /* cmp eax,2 ; je 0x15b450 ; pxor xmm0,xmm0 ; jmp 0x15b427 ; nopl */
    ks_anchor_before: '4883c418c30f1f4000',  /* add rsp,0x18 ; ret ; nopl, ends at ks_offset */
    ks_anchor_after: 'f20f1005189d3c00ebcd', /* movsd xmm0,[12.3] ; jmp 0x15b427, starts at ks_offset+16 */
};

/* The only bytes any apply/revert may change: the gate byte, the two
 * selfstart regions and the size region. */
var REGIONS = [[KNOWN.gate_offset, 7], [KNOWN.sc_offset, 5], [KNOWN.sg_offset, 6], [KNOWN.ks_offset, 16]];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hexAt(buf, off, len) { return buf.slice(off, off + len).toString('hex'); }
function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }

function backupPath(t) { return t + '.aa-orig'; }
function metaPath(t) { return t + '.aa-orig.json'; }

/* The gate state of a buffer. The anchors pin the offset and the fixed cmp
 * prefix; the immediate tells original from patched. */
function gateState(buf) {
    var before = hexAt(buf, KNOWN.gate_offset - KNOWN.gate_anchor_before.length / 2, KNOWN.gate_anchor_before.length / 2);
    if (before !== KNOWN.gate_anchor_before) return { state: 'unknown', reason: 'gate preceding anchor does not match the known build' };
    var afterOff = KNOWN.gate_offset + 7;
    var after = hexAt(buf, afterOff, KNOWN.gate_anchor_after.length / 2);
    if (after !== KNOWN.gate_anchor_after) return { state: 'unknown', reason: 'gate following anchor does not match the known build' };
    if (hexAt(buf, KNOWN.gate_offset, 6) !== KNOWN.gate_prefix) return { state: 'unknown', reason: 'gate cmp prefix does not match the known build' };
    var imm = buf[KNOWN.gate_offset + 6];
    if (imm === KNOWN.gate_imm_original) return { state: 'original' };
    if (imm === KNOWN.gate_imm_patched) return { state: 'patched' };
    return { state: 'unknown', reason: 'gate immediate 0x' + imm.toString(16) + ' is neither original nor patched' };
}

/* The selfstart/call state: which of the two known 5-byte sequences sits at
 * sc_offset, anchored on both sides. */
function scState(buf) {
    var before = hexAt(buf, KNOWN.sc_offset - KNOWN.sc_anchor_before.length / 2, KNOWN.sc_anchor_before.length / 2);
    if (before !== KNOWN.sc_anchor_before) return { state: 'unknown', reason: 'selfstart call preceding anchor does not match the known build' };
    var after = hexAt(buf, KNOWN.sc_offset + 5, KNOWN.sc_anchor_after.length / 2);
    if (after !== KNOWN.sc_anchor_after) return { state: 'unknown', reason: 'selfstart call following anchor does not match the known build' };
    var cur = hexAt(buf, KNOWN.sc_offset, 5);
    if (cur === KNOWN.sc_original) return { state: 'original' };
    if (cur === KNOWN.sc_patched) return { state: 'patched' };
    return { state: 'unknown', reason: 'selfstart call bytes ' + cur + ' are neither original nor patched' };
}

/* The selfstart/guard state: which of the two known 6-byte sequences sits at
 * sg_offset, anchored on both sides. */
function sgState(buf) {
    var before = hexAt(buf, KNOWN.sg_offset - KNOWN.sg_anchor_before.length / 2, KNOWN.sg_anchor_before.length / 2);
    if (before !== KNOWN.sg_anchor_before) return { state: 'unknown', reason: 'selfstart guard preceding anchor does not match the known build' };
    var after = hexAt(buf, KNOWN.sg_offset + 6, KNOWN.sg_anchor_after.length / 2);
    if (after !== KNOWN.sg_anchor_after) return { state: 'unknown', reason: 'selfstart guard following anchor does not match the known build' };
    var cur = hexAt(buf, KNOWN.sg_offset, 6);
    if (cur === KNOWN.sg_original) return { state: 'original' };
    if (cur === KNOWN.sg_patched) return { state: 'patched' };
    return { state: 'unknown', reason: 'selfstart guard bytes ' + cur + ' are neither original nor patched' };
}

/* The size state: which of the two known 16-byte sequences sits at
 * ks_offset, anchored on both sides. */
function ksState(buf) {
    var before = hexAt(buf, KNOWN.ks_offset - KNOWN.ks_anchor_before.length / 2, KNOWN.ks_anchor_before.length / 2);
    if (before !== KNOWN.ks_anchor_before) return { state: 'unknown', reason: 'size preceding anchor does not match the known build' };
    var after = hexAt(buf, KNOWN.ks_offset + 16, KNOWN.ks_anchor_after.length / 2);
    if (after !== KNOWN.ks_anchor_after) return { state: 'unknown', reason: 'size following anchor does not match the known build' };
    var cur = hexAt(buf, KNOWN.ks_offset, 16);
    if (cur === KNOWN.ks_original) return { state: 'original' };
    if (cur === KNOWN.ks_patched) return { state: 'patched' };
    return { state: 'unknown', reason: 'size bytes ' + cur + ' are neither original nor patched' };
}

function classify(buf) {
    if (buf.length !== KNOWN.size) return { ok: false, reason: 'size ' + buf.length + ' != ' + KNOWN.size + ' (unrecognised build)' };
    return { ok: true, gate: gateState(buf), sc: scState(buf), sg: sgState(buf), ks: ksState(buf) };
}

function readTarget(t) {
    try { return fs.readFileSync(t); } catch (e) { die('cannot read ' + t + ': ' + e.message); }
}

function cmdStatus(target) {
    var buf = readTarget(target);
    var hash = sha256(buf);
    var c = classify(buf);
    process.stdout.write('target:   ' + target + '\n');
    process.stdout.write('size:     ' + buf.length + '\n');
    process.stdout.write('sha256:   ' + hash + '\n');
    if (!c.ok) { process.stdout.write('known:    NO — ' + c.reason + '\n'); return; }
    var known = (hash === KNOWN.sha256_original) ? 'yes, pristine ' + KNOWN.version
        : (c.gate.state !== 'unknown' && c.sc.state !== 'unknown' && c.sg.state !== 'unknown' && c.ks.state !== 'unknown') ? 'yes, modified build' : 'NO — unrecognised';
    process.stdout.write('known:    ' + known + '\n');
    process.stdout.write('gate:     ' + (c.gate.state === 'original' ? 'ORIGINAL (cluster screen gated off: KombiVariant <= 1)'
        : c.gate.state === 'patched' ? 'PATCHED (cluster screen enabled: KombiVariant <= 2)'
        : 'UNKNOWN (' + c.gate.reason + ')') + '\n');
    process.stdout.write('selfstart:' + (c.sc.state === 'original' && c.sg.state === 'original' ? ' ORIGINAL (waits for StreamCommandChanged; stream never starts on this build)'
        : c.sc.state === 'patched' && c.sg.state === 'patched' ? ' SELF-START (aapd requests the alternate stream itself once navigation is active)'
        : ' PARTIAL/UNKNOWN (call ' + c.sc.state + (c.sc.reason ? ' — ' + c.sc.reason : '') + ', guard ' + c.sg.state + (c.sg.reason ? ' — ' + c.sg.reason : '') + ')') + '\n');
    process.stdout.write('size:     ' + (c.ks.state === 'original' ? 'ORIGINAL (KombiVariant 2 has no screen size: built-in 800x480 defaults, aapd.conf unused)'
        : c.ks.state === 'patched' ? 'PATCHED (KombiVariant 2 reads the 12.3" aapd.conf profile)'
        : 'UNKNOWN (' + c.ks.reason + ')') + '\n');
    process.stdout.write('backup:   ' + (fs.existsSync(backupPath(target)) ? backupPath(target) : 'none') + '\n');
}

function cmdApply(target, yes, gateOnly) {
    var buf = readTarget(target);
    var hash = sha256(buf);
    var c = classify(buf);
    if (!c.ok) die('refusing: ' + c.reason);
    if (c.gate.state === 'unknown') die('refusing: ' + c.gate.reason);
    if (!gateOnly) {
        if (c.sc.state === 'unknown') die('refusing: ' + c.sc.reason);
        if (c.sg.state === 'unknown') die('refusing: ' + c.sg.reason);
        if (c.ks.state === 'unknown') die('refusing: ' + c.ks.reason);
    }

    /* Back up the pristine original before the first edit; require that a
     * pre-existing backup is that same original. */
    var bak = backupPath(target);
    if (!fs.existsSync(bak)) {
        if (hash !== KNOWN.sha256_original) die('first edit requires the pristine build (sha256 ' + KNOWN.sha256_original + '), got ' + hash);
        fs.writeFileSync(bak, buf, { mode: 0o600 });
        fsyncFile(bak);
        if (sha256(fs.readFileSync(bak)) !== hash) { try { fs.unlinkSync(bak); } catch (e) {} die('backup verification failed; no change made'); }
        fs.writeFileSync(metaPath(target), JSON.stringify({ target: path.resolve(target), version: KNOWN.version, sha256_original: hash, savedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    } else if (sha256(fs.readFileSync(bak)) !== KNOWN.sha256_original) {
        die('existing backup ' + bak + ' is not the known original; refusing');
    }

    var out = Buffer.from(buf);
    var changed = [];
    if (c.gate.state !== 'patched') {
        out[KNOWN.gate_offset + 6] = KNOWN.gate_imm_patched;
        changed.push('gate -> cluster screen enabled (KombiVariant <= 2)');
    }
    if (!gateOnly) {
        if (c.sc.state !== 'patched') {
            Buffer.from(KNOWN.sc_patched, 'hex').copy(out, KNOWN.sc_offset);
            changed.push('selfstart call -> requestStream');
        }
        if (c.sg.state !== 'patched') {
            Buffer.from(KNOWN.sg_patched, 'hex').copy(out, KNOWN.sg_offset);
            changed.push('selfstart guard -> unconditional');
        }
        if (c.ks.state !== 'patched') {
            Buffer.from(KNOWN.ks_patched, 'hex').copy(out, KNOWN.ks_offset);
            changed.push('size -> KombiVariant 2 reads the 12.3" profile');
        }
    }
    if (changed.length === 0) { process.stdout.write('nothing to do; already in the requested state\n'); return; }

    process.stdout.write('About to patch ' + target + ':\n');
    changed.forEach(function (x) { process.stdout.write('  ' + x + '\n'); });
    if (!yes) die('pass --yes to proceed');

    writeInPlace(target, out);

    var after = readTarget(target);
    var cc = classify(after);
    if (!cc.ok || cc.gate.state !== 'patched') die('post-write verification failed (' + ((cc.gate && cc.gate.reason) || 'gate ' + (cc.gate && cc.gate.state)) + '); restore from ' + bak);
    if (!gateOnly) {
        if (cc.sc.state !== 'patched') die('post-write selfstart-call verification failed (' + (cc.sc.reason || cc.sc.state) + '); restore from ' + bak);
        if (cc.sg.state !== 'patched') die('post-write selfstart-guard verification failed (' + (cc.sg.reason || cc.sg.state) + '); restore from ' + bak);
        if (cc.ks.state !== 'patched') die('post-write size verification failed (' + (cc.ks.reason || cc.ks.state) + '); restore from ' + bak);
    }
    if (!onlyRegionsDiffer(buf, after, REGIONS)) die('post-write verification failed: bytes outside the patched regions changed; restore from ' + bak);
    process.stdout.write('patched OK. sha256 now ' + sha256(after) + '\n');
    process.stdout.write('revert:  aapd_patch.js revert --target ' + target + ' --yes\n');
}

/* Revert puts the backup's bytes back in the edit's region; the rest of the
 * target is left as it is. --force restores the whole backup, also over a
 * target it does not recognise. --drop-backup deletes the backup once the edit
 * is gone, for a removal of the feature. */
function cmdRevert(target, yes, force, dropBackup) {
    var bak = backupPath(target);
    function drop() {
        if (!dropBackup) return;
        [bak, metaPath(target)].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') die('dropping ' + f + ': ' + e.message); } });
        process.stdout.write('backup dropped\n');
    }
    if (!fs.existsSync(bak)) die('no backup at ' + bak + '; cannot revert');
    var orig = fs.readFileSync(bak);
    var origHash = sha256(orig);
    var meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(target), 'utf8')); } catch (e) {}
    var expect = meta && meta.sha256_original ? meta.sha256_original : KNOWN.sha256_original;
    if (origHash !== expect) die('backup sha256 ' + origHash + ' != expected ' + expect + '; refusing to restore an unrecognised backup');

    var cur = readTarget(target);
    if (sha256(cur) === origHash) { process.stdout.write('already at the original; nothing to do\n'); drop(); return; }
    /* Only restore over a binary we recognise as a patched form of this build;
     * if a firmware update replaced aapd and left the old backup behind,
     * restoring would downgrade it. */
    var c = classify(cur);
    var cUnknown = !c.ok || c.gate.state === 'unknown' || c.sc.state === 'unknown' || c.sg.state === 'unknown' || c.ks.state === 'unknown';
    if (cUnknown && !force) {
        die('current ' + target + ' is not a recognised patched build of this backup' +
            (c.ok ? ' (' + (c.gate.reason || c.sc.reason || c.sg.reason || c.ks.reason) + ')' : ' (' + c.reason + ')') +
            '.\n  It may have been replaced (e.g. a firmware update). Refusing to overwrite it.' +
            '\n  Pass --force only if you are sure this backup is the right original for it.');
    }
    var recognised = !cUnknown;
    var out = Buffer.from(orig);
    if (recognised && !force) {
        out = Buffer.from(cur);
        REGIONS.forEach(function (r) { orig.copy(out, r[0], r[0], r[0] + r[1]); });
        if (out.equals(cur)) { process.stdout.write('nothing to do: the edits are not in it; other changes kept\n'); drop(); return; }
    }
    process.stdout.write('About to restore ' + (recognised && !force ? 'the edited regions of ' : '') + target + ' from ' + bak + ' (sha256 ' + origHash + ')\n');
    if (!yes) die('pass --yes to proceed');
    writeInPlace(target, out);
    var after = readTarget(target), ca = classify(after);
    if (!after.equals(out) || !ca.ok || ca.gate.state !== 'original' || ca.sc.state !== 'original' || ca.sg.state !== 'original' || ca.ks.state !== 'original') die('restore verification failed');
    process.stdout.write(sha256(after) === origHash ? 'restored OK. sha256 now ' + origHash + '\n'
        : 'restored the edited region; changes outside it kept. sha256 now ' + sha256(after) + '\n');
    if (dropBackup) drop();
    else process.stdout.write('You may delete the backup: ' + bak + ' and ' + metaPath(target) + '\n');
}

function cmdVerify(target) {
    var buf = readTarget(target);
    var c = classify(buf);
    if (!c.ok) { process.stderr.write('FAIL: ' + c.reason + '\n'); process.exit(1); }
    if (c.gate.state === 'unknown') { process.stderr.write('FAIL: ' + c.gate.reason + '\n'); process.exit(1); }
    if (c.sc.state === 'unknown') { process.stderr.write('FAIL: ' + c.sc.reason + '\n'); process.exit(1); }
    if (c.sg.state === 'unknown') { process.stderr.write('FAIL: ' + c.sg.reason + '\n'); process.exit(1); }
    if (c.ks.state === 'unknown') { process.stderr.write('FAIL: ' + c.ks.reason + '\n'); process.exit(1); }
    /* A gate-only build (sc/sg both original) is a valid, deliberate partial
     * state (--gate-only). Anything else needs both selfstart edits together. */
    var selfstartOff = c.sc.state === 'original' && c.sg.state === 'original';
    var selfstartOn = c.sc.state === 'patched' && c.sg.state === 'patched';
    if (!selfstartOff && !selfstartOn) {
        process.stderr.write('FAIL: partially patched selfstart — call ' + c.sc.state + ', guard ' + c.sg.state + ' (apply enables both together)\n');
        process.exit(1);
    }
    process.stdout.write('OK: gate ' + (c.gate.state === 'patched' ? 'enabled (KombiVariant <= 2)' : 'original (gated off)') +
        ', selfstart ' + (selfstartOn ? 'on' : 'off') + ', size ' + c.ks.state + '\n');
}

/* Write by atomic rename so a crash mid-write cannot leave aapd half patched;
 * fall back to in-place rewrite on a cross-device/busy rename. The caller
 * remounts / read-write around this (deploy's remount window). */
function fsyncFile(p) {
    var fd = fs.openSync(p, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeInPlace(target, buf) {
    var tmp = target + '.aa-tmp';
    var st;
    try { st = fs.statSync(target); } catch (e) { st = { mode: 0o755 }; }
    fs.writeFileSync(tmp, buf, { mode: st.mode & 0o777 });
    fsyncFile(tmp);   /* the bytes must be on disk before the rename */
    try { fs.renameSync(tmp, target); }
    catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        var fd = fs.openSync(target, 'r+');
        try { fs.writeSync(fd, buf, 0, buf.length, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
}

function onlyRegionsDiffer(a, b, regions) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        var inside = regions.some(function (r) { return i >= r[0] && i < r[0] + r[1]; });
        if (!inside) return false;
    }
    return true;
}

function parseArgs(argv) {
    var a = { _: [] };
    for (var i = 0; i < argv.length; i++) {
        var t = argv[i];
        if (t === '--yes') a.yes = true;
        else if (t === '--force') a.force = true;
        else if (t === '--drop-backup') a.dropBackup = true;
        else if (t === '--gate-only') a.gateOnly = true;
        else if (t === '--target') a.target = argv[++i];
        else a._.push(t);
    }
    return a;
}

function main() {
    var a = parseArgs(process.argv.slice(2));
    var cmd = a._[0];
    var target = a.target || '/usr/bin/aapd';
    if (cmd === 'status') cmdStatus(target);
    else if (cmd === 'apply') cmdApply(target, a.yes, a.gateOnly);
    else if (cmd === 'revert') cmdRevert(target, a.yes, a.force, a.dropBackup);
    else if (cmd === 'verify') cmdVerify(target);
    else { process.stderr.write('usage: aapd_patch.js status|apply|revert|verify [--target <file>] [--yes] [--force] [--drop-backup] [--gate-only]\n'); process.exit(2); }
}

module.exports = { KNOWN: KNOWN, classify: classify, sha256: sha256, backupPath: backupPath };

if (require.main === module) main();
