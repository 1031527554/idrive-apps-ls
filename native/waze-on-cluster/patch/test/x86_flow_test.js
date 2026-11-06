#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* x86_flow.js on hand-written machine code (no firmware): the writes of
 * the byte and string forms that alias other registers, the encodings it
 * refuses, and the flow's register and stack tracking along every path,
 * also through code outside the function, with each case it cannot follow
 * refusing.
 *
 *   node x86_flow_test.js
 */
'use strict';

var X = require('../x86_flow.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function dec(hex) { var b = Buffer.from(hex, 'hex'); return X.decode(b, 0, b.length); }
function writes(hex) { var d = dec(hex); return d ? d.w.slice().sort(function (a, b) { return a - b; }).join() : 'not decoded'; }

/* ---- decode ---- */
ok('xchg ah,bl writes rax and rbx', writes('86e3') === '0,3', writes('86e3'));
ok('with REX, xchg spl,bl writes rsp and rbx', writes('4086e3') === '3,4', writes('4086e3'));
ok('xadd bl,ah writes rax and rbx', writes('0fc0e3') === '0,3', writes('0fc0e3'));
ok('cmpxchg bh,ah writes rax and rbx (al and bh)', writes('0fb0e7') === '0,3', writes('0fb0e7'));
ok('pcmpistri writes ecx', /(^|,)1(,|$)/.test(writes('660f3a63c100')), writes('660f3a63c100'));
ok('pcmpestri writes ecx', /(^|,)1(,|$)/.test(writes('660f3a61c100')), writes('660f3a61c100'));
ok('repne scasb writes rdi and rcx', /(^|,)1(,|$)/.test(writes('f2ae')) && /(^|,)7(,|$)/.test(writes('f2ae')), writes('f2ae'));
[['67 (32-bit addressing)', '678d06'], ['66 push', '6650'], ['66 pop', '6658'], ['66 push imm8', '666a01'], ['66 push imm16', '66680100'],
 ['66 pop r/m', '668fc0'], ['66 push r/m', '66ff30'], ['66 call r/m', '66ffd0'], ['pop rsp', '5c'], ['pop rsp through 8f /0', '8fc4'], ['an x87 instruction', 'dd0424'], ['a byte invalid in 64-bit code', '06']]
    .forEach(function (t) { ok('refused: ' + t[0], dec(t[1]) === null, JSON.stringify(dec(t[1]))); });
ok('pop r12 is decoded', writes('415c') === '12', writes('415c'));

/* ---- flow ---- */
var CODE = 0x1000;
/* A buffer holding `fn` at 0 and `outside` parts at their offsets, the rest
 * int3. flow over [0, fn's length), paths free to leave it in the buffer. */
function run(fnHex, outside) {
    var b = Buffer.alloc(CODE, 0xcc), fn = Buffer.from(fnHex, 'hex');
    fn.copy(b, 0);
    Object.keys(outside || {}).forEach(function (o) { Buffer.from(outside[o], 'hex').copy(b, Number(o)); });
    return X.flow(b, 0, fn.length, 0, b.length);
}
var LEA_RSI_16 = '488d742410', CALL = 'e800000000';
function rsiAt(f, off) { var s = f && f.at(off); return s ? s[6] : 'no flow'; }

var f = run(LEA_RSI_16 + CALL + 'c3');
ok('lea rsi,[rsp+16] ; call: rsi is rsp+16, rsp at the entry depth', rsiAt(f, 5) === 16 && f.at(5)[X.DEPTH] === 0, JSON.stringify(f && f.at(5)));
f = run('4c8d642408' + '4d89e5' + '4983c508' + '4c89ee' + CALL + 'c3');
ok('a copy chain with add: lea r12,[rsp+8] ; mov r13,r12 ; add r13,8 ; mov rsi,r13: rsi is rsp+16', rsiAt(f, 15) === 16, rsiAt(f, 15));
f = run(LEA_RSI_16 + '50' + CALL + '58' + 'c3');
ok('a push after the lea: rsi is rsp+24, rsp 8 deeper', rsiAt(f, 6) === 24 && f.at(6)[X.DEPTH] === 8, JSON.stringify(f && f.at(6)));
f = run(LEA_RSI_16 + '4889c6' + CALL + 'c3');
ok('mov rsi,rax after the lea: rsi unknown', rsiAt(f, 8) === null, rsiAt(f, 8));
f = run(LEA_RSI_16 + CALL + CALL + 'c3');
ok('a call between: rsi unknown at the next call', rsiAt(f, 10) === null, rsiAt(f, 10));
f = run('7405' + LEA_RSI_16 + CALL + 'c3');
ok('a path that skips the lea: rsi unknown at the call', rsiAt(f, 7) === null, rsiAt(f, 7));

ok('refused: an undecodable byte in the function', run(LEA_RSI_16 + '06' + 'c3') === null);
ok('refused: a branch into the middle of an instruction', run('eb01' + LEA_RSI_16 + 'c3') === null);
ok('refused: a reachable indirect jump', run(LEA_RSI_16 + 'ffe0') === null);
ok('an unreachable indirect jump is no matter', run(LEA_RSI_16 + 'c3' + 'ffe0') !== null);
ok('refused: a push and ret (an indirect jump)', run(LEA_RSI_16 + '50' + 'c3') === null);
ok('a ret through leave, rsp unknown, is an exit', run('55' + '4889e5' + LEA_RSI_16 + 'c9' + 'c3') !== null);

/* lea rsi ; je cold ; call ; ret, the cold part outside the function */
var JE_COLD = '0f84' + '00000000';                 /* rel32 filled in below */
function withCold(cold) {
    var fnHex = LEA_RSI_16 + JE_COLD + CALL + 'c3', b = Buffer.from(fnHex, 'hex');
    b.writeInt32LE(0x400 - 11, 7);                 /* je at 5, its next instruction at 11 */
    return run(b.toString('hex'), { 0x400: cold });
}
function jmpBack(from, to) { var b = Buffer.from('e900000000', 'hex'); b.writeInt32LE(to - (from + 5), 1); return b.toString('hex'); }
f = withCold(jmpBack(0x400, 11));
ok('a cold part that jumps straight back: rsi still rsp+16 at the call', rsiAt(f, 11) === 16, rsiAt(f, 11));
f = withCold('4889c6' + jmpBack(0x403, 11));
ok('a cold part that writes rsi and jumps back: rsi unknown at the call', rsiAt(f, 11) === null, rsiAt(f, 11));
f = withCold('c3');
ok('a tail part that never comes back: rsi rsp+16 at the call', rsiAt(f, 11) === 16, rsiAt(f, 11));
ok('refused: an indirect jump in the cold part', withCold('ffe0') === null);
ok('refused: more code outside the function than it follows', withCold(Buffer.alloc(2100, 0x90).toString('hex') + 'c3') === null);
ok('refused: a cold part running off the code', run('e9' + 'fb1f0000' + 'c3') === null);

process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
