// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* x86_flow.js — which general-purpose registers hold a stack address, and
 * which one, at each instruction of an x86-64 function: a forward data-flow
 * pass over the function's control-flow graph, for aapd_locate.js to know
 * what a call is handed.
 *
 * Each register's value is tracked as its offset from rsp (value - rsp), or
 * null when it is anything else or unknown, and rsp itself as its depth
 * below the function's entry. Every path is followed, also through code
 * outside the function a branch or a fall-through reaches (a cold part, a
 * tail call), up to OUTSIDE instructions. The decoder knows the integer,
 * SSE and NOP encodings compilers emit; a function holding a byte sequence
 * it cannot decode, a branch into the middle of one of its instructions, a
 * reachable instruction it cannot decode or indirect jump, a ret with rsp
 * known and not at the entry depth, or more code outside it than OUTSIDE
 * has no flow (null), so nothing is concluded from it. It only reads the
 * buffer.
 *
 * Node 8 on the unit, no dependencies. */
'use strict';

var RSP = 4, DEPTH = 16, OUTSIDE = 2000;
/* A call may change these (System V AMD64): rax rcx rdx rsi rdi r8-r11. */
var CALLER_SAVED = [0, 1, 2, 6, 7, 8, 9, 10, 11];

/* The instruction at `p`: { len, kind ('op' | 'jmp' | 'jcc' | 'call' |
 * 'icall' | 'ijmp' | 'exit'), to (branch target), w (registers written),
 * set ([reg, rule]) } or null when it is not decoded. A rule is how the
 * written value follows: { rsp: d } (rsp+d), { reg: r, d } (r's value + d),
 * or none (not a stack address). */
function decode(buf, p, end) {
    var s = p, rex = 0, op66 = false, rep = 0;
    for (; p < end; p++) {
        var b = buf[p];
        if (b === 0x66) op66 = true;
        else if (b === 0xf2 || b === 0xf3) rep = b;
        else if (b === 0x67) return null;                      /* 32-bit addressing */
        else if (b === 0x2e || b === 0x3e || b === 0x26 || b === 0x36 || b === 0x64 || b === 0x65 || b === 0xf0) continue;
        else break;
    }
    if (p < end && (buf[p] & 0xf0) === 0x40) rex = buf[p++];
    if (p >= end) return null;
    var W = !!(rex & 8), R = (rex & 4) << 1, X = (rex & 2) << 2, B = (rex & 1) << 3;
    var opc = buf[p++], two = false, three = 0;
    if (opc === 0x0f) {
        if (p >= end) return null;
        two = true; opc = buf[p++];
        if (opc === 0x38 || opc === 0x3a) { three = opc; if (p >= end) return null; opc = buf[p++]; }
    }
    var m = null;
    function modrm() {
        if (p >= end) return false;
        var v = buf[p++], mod = v >> 6, rm = v & 7, base = -1, index = -1, disp = 0;
        if (mod !== 3 && rm === 4) {
            if (p >= end) return false;
            var sib = buf[p++];
            base = (sib & 7) | B; index = ((sib >> 3) & 7) | X;
            if (index === RSP) index = -1;
            if ((sib & 7) === 5 && mod === 0) { base = -1; disp = 4; }
        } else if (mod === 0 && rm === 5) { base = -2; disp = 4; }
        else if (mod !== 3) base = rm | B;
        if (mod === 1) disp = 1; else if (mod === 2) disp = 4;
        if (p + disp > end) return false;
        var dv = disp === 1 ? buf.readInt8(p) : disp === 4 ? buf.readInt32LE(p) : 0;
        p += disp;
        m = { mod: mod, reg: ((v >> 3) & 7) | R, rm: rm | B, base: base, index: index, disp: dv };
        return true;
    }
    function imm(n) { if (p + n > end) return false; p += n; return true; }
    /* An 8-bit register without REX: 4-7 are ah, ch, dh, bh. */
    function r8(r) { return !rex && r >= 4 && r < 8 ? r - 4 : r; }
    var out = { kind: 'op', w: [], set: [] };
    function done() { out.len = p - s; return out; }
    function wr(r, rule) { out.w.push(r); out.set.push([r, rule || null]); }

    if (!two) {
        if (opc < 0x40 && (opc & 7) < 6) {                     /* the ALU block */
            var cmp = (opc & 0x38) === 0x38, k = opc & 7;
            if (k < 4) { if (!modrm()) return null; }
            else if (!imm(k === 4 ? 1 : op66 ? 2 : 4)) return null;
            if (!cmp) {
                if (k === 0 || k === 1) { if (m.mod === 3) wr(k === 0 ? r8(m.rm) : m.rm); }
                else if (k === 2 || k === 3) wr(k === 2 ? r8(m.reg) : m.reg);
                else wr(0);
            }
            return done();
        }
        if (op66 && ((opc >= 0x50 && opc <= 0x5f) || opc === 0x68 || opc === 0x6a || opc === 0x8f)) return null;   /* 16-bit stack moves */
        if (opc >= 0x50 && opc <= 0x57) { out.push = 8; return done(); }
        if (opc >= 0x58 && opc <= 0x5f) { if (((opc & 7) | B) === RSP) return null; out.push = -8; wr((opc & 7) | B); return done(); }
        if (opc === 0x63) { if (!modrm()) return null; wr(m.reg); return done(); }
        if (opc === 0x68 || opc === 0x6a) { if (!imm(opc === 0x68 ? 4 : 1)) return null; out.push = 8; return done(); }
        if (opc === 0x69 || opc === 0x6b) { if (!modrm() || !imm(opc === 0x69 ? (op66 ? 2 : 4) : 1)) return null; wr(m.reg); return done(); }
        if (opc >= 0x70 && opc <= 0x7f) { if (!imm(1)) return null; out.kind = 'jcc'; out.to = p + buf.readInt8(p - 1); return done(); }
        if (opc >= 0x80 && opc <= 0x83) {
            if (!modrm() || !imm(opc === 0x81 ? (op66 ? 2 : 4) : 1)) return null;
            var g = m.reg & 7, iv = opc === 0x81 ? buf.readInt32LE(p - 4) : buf.readInt8(p - 1);
            if (g === 7 || m.mod !== 3) return done();
            var dst = opc === 0x80 ? r8(m.rm) : m.rm;
            if (dst === RSP && W && opc !== 0x80 && (g === 0 || g === 5)) { out.push = g === 0 ? -iv : iv; return done(); }
            wr(dst, W && (g === 0 || g === 5) ? { reg: dst, d: g === 0 ? iv : -iv } : null);
            return done();
        }
        if (opc === 0x84 || opc === 0x85) { if (!modrm()) return null; return done(); }
        if (opc === 0x86 || opc === 0x87) {
            if (!modrm()) return null;
            wr(opc === 0x86 ? r8(m.reg) : m.reg);
            if (m.mod === 3) wr(opc === 0x86 ? r8(m.rm) : m.rm);
            return done();
        }
        if (opc >= 0x88 && opc <= 0x8b) {
            if (!modrm()) return null;
            var load = opc >= 0x8a, d8 = !(opc & 1);
            if (load) wr(d8 ? r8(m.reg) : m.reg, m.mod === 3 && W && !d8 ? { reg: m.rm, d: 0 } : null);
            else if (m.mod === 3) wr(d8 ? r8(m.rm) : m.rm, W && !d8 ? { reg: m.reg, d: 0 } : null);
            return done();
        }
        if (opc === 0x8d) {
            if (!modrm() || m.mod === 3) return null;
            wr(m.reg, W && m.base >= 0 && m.index < 0 ? { reg: m.base, d: m.disp } : null);
            return done();
        }
        if (opc === 0x8f) { if (!modrm() || (m.reg & 7) || (m.mod === 3 && m.rm === RSP)) return null; out.push = -8; if (m.mod === 3) wr(m.rm); return done(); }
        if (opc === 0x90 && !B) return done();
        if (opc >= 0x90 && opc <= 0x97) { wr(0); wr((opc & 7) | B); return done(); }
        if (opc === 0x98) { wr(0); return done(); }
        if (opc === 0x99) { wr(2); return done(); }
        if (opc >= 0xa4 && opc <= 0xaf && opc !== 0xa8 && opc !== 0xa9) {      /* string instructions: rdi, rsi, rax and rcx (rep) */
            if (opc < 0xa8 || opc > 0xab) wr(opc >= 0xac ? 0 : 6);
            if (opc < 0xac) { wr(7); if (opc <= 0xa7) wr(6); }
            else if (opc >= 0xae) wr(7);
            else wr(6);
            if (rep) wr(1);
            return done();
        }
        if (opc === 0xa8 || opc === 0xa9) { if (!imm(opc === 0xa8 ? 1 : op66 ? 2 : 4)) return null; return done(); }
        if (opc >= 0xb0 && opc <= 0xb7) { if (!imm(1)) return null; wr(r8((opc & 7) | B)); return done(); }
        if (opc >= 0xb8 && opc <= 0xbf) { if (!imm(W ? 8 : op66 ? 2 : 4)) return null; wr((opc & 7) | B); return done(); }
        if (opc === 0xc0 || opc === 0xc1 || (opc >= 0xd0 && opc <= 0xd3)) {
            if (!modrm() || (opc < 0xd0 && !imm(1))) return null;
            if (m.mod === 3) wr(opc & 1 ? m.rm : r8(m.rm));
            return done();
        }
        if (opc === 0xc2 || opc === 0xc3) { if (opc === 0xc2 && !imm(2)) return null; out.kind = 'exit'; out.ret = true; return done(); }
        if (opc === 0xc6 || opc === 0xc7) {
            if (!modrm() || (m.reg & 7) || !imm(opc === 0xc6 ? 1 : op66 ? 2 : 4)) return null;
            if (m.mod === 3) wr(opc === 0xc6 ? r8(m.rm) : m.rm);
            return done();
        }
        if (opc === 0xc9) { out.unknownRsp = true; wr(5); return done(); }
        if (opc === 0xcc || opc === 0xf4) { out.kind = 'exit'; return done(); }
        if (opc === 0xe8 || opc === 0xe9) {
            if (!imm(4)) return null;
            out.kind = opc === 0xe8 ? 'call' : 'jmp'; out.to = p + buf.readInt32LE(p - 4);
            return done();
        }
        if (opc === 0xeb) { if (!imm(1)) return null; out.kind = 'jmp'; out.to = p + buf.readInt8(p - 1); return done(); }
        if (opc === 0xf6 || opc === 0xf7) {
            if (!modrm()) return null;
            var g3 = m.reg & 7;
            if (g3 < 2) { if (!imm(opc === 0xf6 ? 1 : op66 ? 2 : 4)) return null; return done(); }
            if (g3 < 4) { if (m.mod === 3) wr(opc === 0xf6 ? r8(m.rm) : m.rm); return done(); }
            wr(0); wr(2);
            return done();
        }
        if (opc === 0xfe || opc === 0xff) {
            if (!modrm()) return null;
            var g5 = m.reg & 7;
            if (g5 < 2) { if (m.mod === 3) wr(opc === 0xfe ? r8(m.rm) : m.rm); return done(); }
            if (opc === 0xff && op66 && g5 >= 2 && g5 <= 6) return null;   /* 16-bit calls, jumps and pushes */
            if (opc === 0xff && (g5 === 2 || g5 === 3)) { out.kind = 'icall'; return done(); }
            if (opc === 0xff && (g5 === 4 || g5 === 5)) { out.kind = 'ijmp'; return done(); }
            if (opc === 0xff && g5 === 6) { out.push = 8; return done(); }
            return null;
        }
        return null;
    }
    if (three === 0x38) { if (opc >= 0xf0 || !modrm()) return null; return done(); }
    if (three === 0x3a) {
        if (!modrm() || !imm(1)) return null;
        if (opc >= 0x14 && opc <= 0x17 && m.mod === 3) wr(m.rm);
        if (opc >= 0x60 && opc <= 0x63) wr(1);                    /* pcmp*str*: the index in ecx */
        return done();
    }
    if (opc === 0x0b) { out.kind = 'exit'; return done(); }
    if (opc === 0xae) { if (!modrm()) return null; if (m.mod === 3 && rep === 0xf3) wr(m.rm); return done(); }
    if (opc === 0x1f || opc === 0x18 || opc === 0x0d) { if (!modrm()) return null; return done(); }
    if ((opc >= 0x10 && opc <= 0x17) || opc === 0x28 || opc === 0x29 || opc === 0x2a || opc === 0x2b || opc === 0x2e || opc === 0x2f ||
        (opc >= 0x50 && opc <= 0x6f && opc !== 0x50) || (opc >= 0x74 && opc <= 0x76) || opc === 0x7f || (opc >= 0xd1 && opc <= 0xfe && opc !== 0xd7 && opc !== 0xf7)) {
        if (!modrm()) return null;
        return done();
    }
    if (opc === 0x2c || opc === 0x2d || opc === 0x50 || opc === 0xd7) { if (!modrm()) return null; wr(m.reg); return done(); }
    if (opc === 0x7e) {
        if (!modrm()) return null;
        if (rep !== 0xf3 && m.mod === 3) wr(m.rm);
        return done();
    }
    if (opc === 0x70 || (opc >= 0x71 && opc <= 0x73) || opc === 0xc2 || opc === 0xc6 || opc === 0xc4 || opc === 0xc5) {
        if (!modrm() || !imm(1)) return null;
        if (opc === 0xc5 && m.mod === 3) wr(m.reg);
        return done();
    }
    if (opc >= 0x40 && opc <= 0x4f) { if (!modrm()) return null; wr(m.reg); return done(); }
    if (opc >= 0x80 && opc <= 0x8f) { if (!imm(4)) return null; out.kind = 'jcc'; out.to = p + buf.readInt32LE(p - 4); return done(); }
    if (opc >= 0x90 && opc <= 0x9f) { if (!modrm()) return null; if (m.mod === 3) wr(r8(m.rm)); return done(); }
    if (opc === 0xa3) { if (!modrm()) return null; return done(); }
    if (opc === 0xab || opc === 0xb3 || opc === 0xbb || opc === 0xa5 || opc === 0xad || opc === 0xa4 || opc === 0xac) {
        if (!modrm() || ((opc === 0xa4 || opc === 0xac) && !imm(1))) return null;
        if (m.mod === 3) wr(m.rm);
        return done();
    }
    if (opc === 0xaf || opc === 0xb6 || opc === 0xb7 || opc === 0xbe || opc === 0xbf || opc === 0xbc || opc === 0xbd || opc === 0xb8) {
        if (!modrm()) return null; wr(m.reg); return done();
    }
    if (opc === 0xb0 || opc === 0xb1) { if (!modrm()) return null; wr(0); if (m.mod === 3) wr(opc === 0xb0 ? r8(m.rm) : m.rm); return done(); }
    if (opc === 0xc0 || opc === 0xc1) {
        if (!modrm()) return null;
        wr(opc === 0xc0 ? r8(m.reg) : m.reg);
        if (m.mod === 3) wr(opc === 0xc0 ? r8(m.rm) : m.rm);
        return done();
    }
    if (opc === 0xba) {
        if (!modrm() || !imm(1)) return null;
        if ((m.reg & 7) > 4 && m.mod === 3) wr(m.rm);
        return done();
    }
    if (opc >= 0xc8 && opc <= 0xcf) { wr((opc & 7) | B); return done(); }
    return null;
}

/* The flow of the function [fn, end), whose paths may leave it within
 * [lo, hi): { at(off) -> on entry to the instruction at off, an array of
 * 17: each register's rsp offset (null where not a stack address) and at
 * DEPTH rsp's depth below the function's entry (null where paths differ),
 * or undefined when off is not reached }, or null when the function cannot
 * be followed. */
function flow(buf, fn, end, lo, hi) {
    var own = {}, ins = {}, outside = 0;
    for (var p = fn; p < end;) {
        var d = decode(buf, p, end);
        if (!d) return null;
        own[p] = d; p += d.len;
    }
    /* the instruction at `at`, or null: inside the function only at an
     * instruction start, outside it decoded where a path goes */
    function insAt(at) {
        if (at >= fn && at < end) return own[at] || null;
        if (at < lo || at >= hi) return null;
        if (!(at in ins)) ins[at] = ++outside > OUTSIDE ? null : decode(buf, at, hi);
        return ins[at];
    }
    var state = {}, work = [fn];
    state[fn] = new Array(17).fill(null);
    state[fn][RSP] = 0;
    state[fn][DEPTH] = 0;
    function join(at, st) {
        var cur = state[at];
        if (!cur) { state[at] = st.slice(); work.push(at); return; }
        var changed = false;
        for (var i = 0; i < 17; i++) if (cur[i] !== null && cur[i] !== st[i]) { cur[i] = null; changed = true; }
        if (changed) work.push(at);
    }
    while (work.length) {
        var at = work.pop(), i = insAt(at), st = state[at].slice();
        if (!i || i.kind === 'ijmp') return null;
        var before = st.slice();
        if (i.push) {
            for (var r = 0; r < 16; r++) if (r !== RSP && st[r] !== null) st[r] += i.push;
            if (st[DEPTH] !== null) st[DEPTH] += i.push;
        }
        if (i.unknownRsp) { for (r = 0; r < 16; r++) if (r !== RSP) st[r] = null; st[DEPTH] = null; }
        i.set.forEach(function (x) {
            var rule = x[1];
            st[x[0]] = !rule ? null : before[rule.reg] === null || before[rule.reg] === undefined ? null : before[rule.reg] + rule.d + (i.push || 0);
        });
        if (i.w.indexOf(RSP) >= 0 && !i.push) { for (r = 0; r < 16; r++) if (r !== RSP) st[r] = null; st[DEPTH] = null; }
        st[RSP] = 0;
        if (i.kind === 'call' || i.kind === 'icall') CALLER_SAVED.forEach(function (c) { st[c] = null; });
        if (i.kind === 'exit') {
            if (i.ret && st[DEPTH] !== null && st[DEPTH] !== 0) return null;   /* a push and ret: an indirect jump */
            continue;
        }
        if (i.kind === 'jmp' || i.kind === 'jcc') join(i.to, st);
        if (i.kind !== 'jmp') join(at + i.len, st);
    }
    return { at: function (off) { return state[off] ? state[off].slice() : undefined; } };
}

module.exports = { flow: flow, decode: decode, DEPTH: DEPTH };
