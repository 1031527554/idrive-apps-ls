#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
/* aapd_conf.js — the cluster geometry Android Auto is given, in /etc/aapd.conf.
 *
 * aapd describes its cluster ("alternate") display to the phone from the
 * KOMBI_DISPLAY block, for the screen size its KombiVariant maps to
 * (aapd_patch.js "size": 12.3 for this cluster): the DIMENSIONS entry and the
 * codec definition CODEC_SUPPORTED names (HIGH_1080P for 12.3, MID_1080P for
 * 10.25). The video resolution follows CODEC_HEIGHT (480 -> 800x480, 720 ->
 * 1280x720, 1080 -> 1920x1080), the density REPORTED_SCREEN_DENSITY, and the
 * UI margins are
 *     left/top     = OFFSET_LEFT/TOP_TARGET_VIEWPORT
 *     right/bottom = HORIZONTAL/VERTICAL_MARGIN_SIZE - left/top
 * with the stable and current content insets the entry's safe area
 * (SA_*PIXELS) less that offset. Stock, it asks for 1920x1080 laid out for a
 * cluster that draws the stream across the panel.
 *
 * The map slot waze-on-cluster draws the stream into is 1088x480 (2.27:1) at
 * 138x61 mm. This edit asks for 1280x720 with its UI the top 1280x564
 * (margins 0 x 156 at 0,0), the slot's shape: waze-on-cluster's src_crop
 * takes that 1280x564 and scales it 0.85x into the whole slot, so the slot
 * gets more detail than it has pixels. The density is the owner's choice of
 * DENSITIES (aoc.js density: 150-400 in steps of 10): about 235 dpi is the
 * slot's own for 1280 pixels, and
 * a lower one makes the phone take the screen for a larger one, so it shows
 * more map with its text and turn card smaller (200: about 15%, 180: about
 * 30%; 180 unless chosen). With the turn card hidden (the owner's choice
 * of CARDS) the UI is the whole picture and the safe area starts at its top;
 * see geometry(). The safe area is the CarPlay patch's proven one for the slot
 * (504x368 at 286,72) at that scale, 592x432 at 336,84, so the phone keeps
 * its turn card where the gauges leave the slot clear. Both codec definitions
 * and both DIMENSIONS entries get it. Nothing else in the file changes: the
 * numbers are replaced in place, so its layout is kept byte for byte.
 *
 * Earlier releases of this tool edited the same keys for a 1920x1080 stream
 * (its UI the top-left 1088x480; 0.1.0) and an 800x480 one (its UI the top
 * 800x352; 0.2.0). A file holding either, or this edit at another of
 * DENSITIES (0.3.x, or the owner's previous choice), is recognised ("stale"),
 * re-edited by apply and restored by revert.
 *
 * The original file is pinned by SHA-256, saved before the first edit and
 * checked before any restore; a file that is neither the original nor this
 * edit of it (a firmware update) is never touched.
 *
 *   aapd_conf.js status [--target <file>] [--dpi <n>] [--card shown|hidden]
 *   aapd_conf.js apply  [--target <file>] [--dpi <n>] [--card shown|hidden]
 *   aapd_conf.js revert [--target <file>] [--drop-backup]
 *
 * apply and revert print one line and exit 0 when the file is (now) in the
 * requested state, 1 otherwise. The caller remounts / read-write around them.
 * aapd reads the file when it starts, which on the unit is the next head-unit
 * start. Node 8, no dependencies. */
'use strict';

var fs = require('fs');
var crypto = require('crypto');

/* /etc/aapd.conf of MGU P18_23w44.2-1-3. */
var ORIGINAL_SHA256 = '9584c540f287bb79744e79cf973795208719ca798f13d881c4dac582656b0f16';

/* The original codec definitions' size, which the edit requires. */
var CODEC = { w: 1920, h: 1080 };
/* The densities and turn-card settings the owner can choose, and the ones
 * used until they do. */
/* Any density from 150 to 400 dpi in steps of 10; 180 is the default. The
 * 150-300 suits the cluster; up to 400 is for trying the map on the HUD. RETIRED are densities an earlier release offered (235, the
 * slot's own for 1280 pixels, now 240): an aapd.conf at one of them is still
 * this tool's edit (recognised, upgraded and restored), and a saved choice
 * of one reads as the nearest step. A value must stay recognised once it has
 * shipped. */
var DENSITY_MIN = 150, DENSITY_MAX = 400, DENSITY_STEP = 10;
var DENSITIES = (function () {
    var l = [];
    for (var d = DENSITY_MIN; d <= DENSITY_MAX; d += DENSITY_STEP) l.push(d);
    return l;
})();
var RETIRED = [235];
var DENSITY_TEXT = DENSITY_MIN + '-' + DENSITY_MAX + ' dpi in steps of ' + DENSITY_STEP;
var DEFAULT_DPI = 180;
var CARDS = ['shown', 'hidden'];
var DEFAULT_CARD = 'shown';
/* What the edit sets: the stream, its UI, density and safe area. dpi null:
 * the densities stay, and the safe area's mm use the entry's own.
 * Card hidden: the UI is the whole 1280x720 and the safe area starts at its
 * top, where Maps pins the turn card; waze-on-cluster crops rows 156..719
 * (aoc_files.js srcCrop), so the card falls in the rows cut off and the safe
 * area's lower edge stays where the shown layout has it on the cluster
 * (672 = 84 + 432 + 156). */
function geometry(dpi, card) {
    var hidden = card === 'hidden';
    return { codec: { w: 1280, h: 720 }, ui: { w: 1280, h: hidden ? 720 : 564 }, dpi: dpi || DEFAULT_DPI,
             safe: hidden ? { x: 336, y: 0, w: 592, h: 672 } : { x: 336, y: 84, w: 592, h: 432 }, card: hidden ? 'hidden' : 'shown' };
}
/* The top rows waze-on-cluster crops off with the card hidden, at least CARD_CUT:
 * the card's height grows with the density (its bottom edge is about 0.62 x dpi
 * rows down: 146 at 235, 248 at 400), so the cut follows it, 10 rows of margin,
 * rounded up to an even number. */
var CARD_CUT = 156;
function cardCut(dpi) {
    return Math.max(CARD_CUT, Math.ceil((0.62 * (dpi || DEFAULT_DPI) + 10) / 2) * 2);
}
var GEOMETRY = geometry(DEFAULT_DPI, DEFAULT_CARD);
/* The earlier releases' edits (0.1.0, 0.2.0), recognised only. */
var STALE = [{ codec: null, ui: { w: 1088, h: 480 }, dpi: null, safe: { x: 286, y: 72, w: 504, h: 368 } },
             { codec: { w: 800, h: 480 }, ui: { w: 800, h: 352 }, dpi: 147, safe: { x: 210, y: 52, w: 370, h: 270 } }];

var CODEC_DEFINITIONS = ['MID_1080P', 'HIGH_1080P'];
var DIMENSIONS = ['10.25', '12.3'];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function backupPath(t) { return t + '.aoc-orig'; }

/* Every number in a JSON text, by its key path ("A/B/C"), with its span.
 * The file is plain JSON (objects, arrays, strings, numbers, literals). */
function numberSpans(text) {
    var spans = {};
    var i = 0;
    function ws() { while (i < text.length && /\s/.test(text[i])) i++; }
    function str() {
        var start = ++i;
        while (text[i] !== '"') { if (text[i] === '\\') i++; i++; if (i >= text.length) throw new Error('unterminated string'); }
        return text.slice(start, i++);
    }
    function value(p) {
        ws();
        var c = text[i];
        if (c === '{') {
            i++; ws();
            if (text[i] === '}') { i++; return; }
            for (;;) {
                ws();
                if (text[i] !== '"') throw new Error('key expected at ' + i);
                var k = str();
                ws();
                if (text[i++] !== ':') throw new Error('colon expected at ' + i);
                value(p ? p + '/' + k : k);
                ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === '}') { i++; return; }
                throw new Error('comma or } expected at ' + i);
            }
        }
        if (c === '[') {
            i++; ws();
            if (text[i] === ']') { i++; return; }
            for (var n = 0; ; n++) {
                value(p + '/' + n);
                ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === ']') { i++; return; }
                throw new Error('comma or ] expected at ' + i);
            }
        }
        if (c === '"') { str(); return; }
        var m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?|^(true|false|null)/.exec(text.slice(i, i + 40));
        if (!m) throw new Error('value expected at ' + i);
        if (!m[3]) spans[p] = [i, i + m[0].length, Number(m[0])];
        i += m[0].length;
    }
    value('');
    ws();
    if (i !== text.length) throw new Error('trailing text at ' + i);
    return spans;
}

function mm(px, dpi) { return Math.round(px / dpi * 25.4 * 1000) / 1000; }

/* The values a geometry sets, by key path, for a parsed original. */
function wanted(spans, g) {
    var w = {};
    CODEC_DEFINITIONS.forEach(function (name) {
        var p = 'SCREENS/KOMBI_DISPLAY/CODEC_DEFINITION/' + name + '/';
        var codec = g.codec || CODEC;
        if (g.codec) {
            w[p + 'CODEC_WIDTH'] = codec.w;
            w[p + 'CODEC_HEIGHT'] = codec.h;
        }
        if (g.dpi) {
            w[p + 'REPORTED_SCREEN_DENSITY'] = g.dpi;
            w[p + 'REAL_SCREEN_DENSITY'] = g.dpi;
        }
        w[p + 'HORIZONTAL_MARGIN_SIZE'] = codec.w - g.ui.w;
        w[p + 'VERTICAL_MARGIN_SIZE'] = codec.h - g.ui.h;
        w[p + 'OFFSET_LEFT_TARGET_VIEWPORT'] = 0;
        w[p + 'OFFSET_TOP_TARGET_VIEWPORT'] = 0;
        w[p + 'WIDTH_TARGET_VIEWPORT'] = g.ui.w;
        w[p + 'HEIGHT_TARGET_VIEWPORT'] = g.ui.h;
    });
    DIMENSIONS.forEach(function (name) {
        var p = 'SCREENS/KOMBI_DISPLAY/DIMENSIONS/' + name + '/';
        var dpi = g.dpi || spans[p + 'SA_PHYSICALDENSITY'][2];
        if (g.dpi) w[p + 'SA_PHYSICALDENSITY'] = g.dpi;
        w[p + 'SA_OFFSET_LEFTPIXELS'] = g.safe.x;
        w[p + 'SA_OFFSET_TOPPIXELS'] = g.safe.y;
        w[p + 'SA_WIDTHPIXELS'] = g.safe.w;
        w[p + 'SA_HEIGHTPIXELS'] = g.safe.h;
        w[p + 'SA_WIDTH'] = mm(g.safe.w, dpi);
        w[p + 'SA_HEIGHT'] = mm(g.safe.h, dpi);
    });
    return w;
}

/* The edited text of an original, or throws why it cannot be edited. g: the
 * geometry, GEOMETRY unless given. */
function transform(text, g) {
    g = g || GEOMETRY;
    var spans = numberSpans(text);
    CODEC_DEFINITIONS.forEach(function (name) {
        var p = 'SCREENS/KOMBI_DISPLAY/CODEC_DEFINITION/' + name + '/';
        if (!spans[p + 'CODEC_WIDTH'] || spans[p + 'CODEC_WIDTH'][2] !== CODEC.w || spans[p + 'CODEC_HEIGHT'][2] !== CODEC.h)
            throw new Error(name + ' is not a ' + CODEC.w + 'x' + CODEC.h + ' codec definition');
    });
    DIMENSIONS.forEach(function (name) {
        if (!spans['SCREENS/KOMBI_DISPLAY/DIMENSIONS/' + name + '/SA_PHYSICALDENSITY'])
            throw new Error('no KOMBI_DISPLAY dimensions ' + name);
    });
    var w = wanted(spans, g);
    var keys = Object.keys(w);
    keys.forEach(function (k) { if (!spans[k]) throw new Error('no ' + k); });
    keys.sort(function (a, b) { return spans[b][0] - spans[a][0]; });
    var out = text;
    keys.forEach(function (k) {
        var s = spans[k];
        out = out.slice(0, s[0]) + String(w[k]) + out.slice(s[1]);
    });
    var check = numberSpans(out);
    keys.forEach(function (k) { if (check[k][2] !== w[k]) throw new Error('edit of ' + k + ' did not take'); });
    JSON.parse(out);
    return out;
}

function readOr(p) { try { return fs.readFileSync(p); } catch (e) { return null; } }

/* The file's state for a chosen density: edited (this edit at dpi), stale
 * (an earlier release's, or this edit at another density), original,
 * unknown or missing. */
function state(target, dpi, card) {
    var cur = readOr(target);
    if (!cur) return { state: 'missing' };
    if (sha256(cur) === ORIGINAL_SHA256) return { state: 'original', cur: cur };
    var bak = readOr(backupPath(target));
    if (bak && sha256(bak) === ORIGINAL_SHA256) {
        var b = bak.toString('utf8'), c = cur.toString('utf8');
        var want = geometry(dpi, card);
        if (transform(b, want) === c) return { state: 'edited', cur: cur, bak: bak };
        var others = STALE.slice();
        DENSITIES.concat(RETIRED).forEach(function (d) {
            CARDS.forEach(function (k) { if (d !== want.dpi || k !== want.card) others.push(geometry(d, k)); });
        });
        if (others.some(function (g) { return transform(b, g) === c; })) return { state: 'stale', cur: cur, bak: bak };
    }
    return { state: 'unknown', cur: cur };
}

function fsyncFile(p) {
    var fd = fs.openSync(p, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAtomic(target, data) {
    var tmp = target + '.aoc-tmp';
    var st = fs.statSync(target);
    fs.writeFileSync(tmp, data, { mode: st.mode & 0o777 });
    try { fs.chownSync(tmp, st.uid, st.gid); } catch (e) {}
    fsyncFile(tmp);
    fs.renameSync(tmp, target);
}

function apply(target, dpi, card) {
    var g = geometry(dpi, card);
    var s = state(target, g.dpi, g.card);
    if (s.state === 'edited') return 'already applied';
    if (s.state === 'stale') {
        writeAtomic(target, transform(s.bak.toString('utf8'), g));
        if (state(target, g.dpi, g.card).state !== 'edited') throw new Error('post-write verification failed; restore ' + backupPath(target));
        return 'applied over the earlier edit: ' + describe(g.dpi, g.card);
    }
    if (s.state !== 'original') throw new Error(target + ' is ' + s.state + ': not the known original (sha256 ' + ORIGINAL_SHA256 + '); left as it is');
    var edited = transform(s.cur.toString('utf8'), g);
    var bak = backupPath(target);
    var old = readOr(bak);
    if (!old || sha256(old) !== ORIGINAL_SHA256) {
        fs.writeFileSync(bak, s.cur, { mode: 0o600 });
        fsyncFile(bak);
        if (sha256(fs.readFileSync(bak)) !== ORIGINAL_SHA256) throw new Error('backup verification failed; nothing changed');
    }
    writeAtomic(target, edited);
    if (state(target, g.dpi, g.card).state !== 'edited') throw new Error('post-write verification failed; restore ' + bak);
    return 'applied: ' + describe(g.dpi, g.card);
}

function describe(dpi, card) {
    var g = geometry(dpi, card);
    return g.codec.w + 'x' + g.codec.h + ' with the cluster UI in its top ' + g.ui.w + 'x' + g.ui.h + ', ' + g.dpi + ' dpi' +
        (g.card === 'hidden' ? ', turn card cropped off' : '');
}

function revert(target, dropBackup) {
    var s = state(target);
    var bak = backupPath(target);
    var msg;
    if (s.state === 'original' || s.state === 'missing') msg = 'already the original';
    else if (s.state === 'edited' || s.state === 'stale') {
        writeAtomic(target, s.bak);
        if (sha256(fs.readFileSync(target)) !== ORIGINAL_SHA256) throw new Error('restore verification failed');
        msg = 'restored the original';
    } else throw new Error(target + ' is not this edit of the known original; left as it is');
    if (dropBackup) { try { fs.unlinkSync(bak); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    return msg;
}

module.exports = { ORIGINAL_SHA256: ORIGINAL_SHA256, GEOMETRY: GEOMETRY, STALE: STALE, DENSITIES: DENSITIES,
                   DENSITY_MIN: DENSITY_MIN, DENSITY_MAX: DENSITY_MAX, DENSITY_STEP: DENSITY_STEP, DENSITY_TEXT: DENSITY_TEXT, RETIRED: RETIRED,
                   DEFAULT_DPI: DEFAULT_DPI, CARDS: CARDS, DEFAULT_CARD: DEFAULT_CARD, CARD_CUT: CARD_CUT, cardCut: cardCut, geometry: geometry, numberSpans: numberSpans,
                   transform: transform, state: state, apply: apply, revert: revert, backupPath: backupPath };

if (require.main === module) {
    var args = process.argv.slice(2);
    var cmd = args[0];
    var ti = args.indexOf('--target');
    var target = ti >= 0 ? args[ti + 1] : '/etc/aapd.conf';
    var di = args.indexOf('--dpi');
    var dpi = di >= 0 ? parseInt(args[di + 1], 10) : DEFAULT_DPI;
    var ci = args.indexOf('--card');
    var card = ci >= 0 ? args[ci + 1] : DEFAULT_CARD;
    try {
        if (cmd === 'status') {
            var st = state(target, dpi, card);
            process.stdout.write(target + ': ' + st.state + (st.cur ? ' (sha256 ' + sha256(st.cur) + ')' : '') + '\n');
        } else if (cmd === 'apply') process.stdout.write(apply(target, dpi, card) + '\n');
        else if (cmd === 'revert') process.stdout.write(revert(target, args.indexOf('--drop-backup') >= 0) + '\n');
        else { process.stderr.write('usage: aapd_conf.js status|apply|revert [--target <file>] [--dpi <n>] [--card shown|hidden] [--drop-backup]\n'); process.exit(2); }
    } catch (e) {
        process.stderr.write('aapd_conf: ' + e.message + '\n');
        process.exit(1);
    }
}
