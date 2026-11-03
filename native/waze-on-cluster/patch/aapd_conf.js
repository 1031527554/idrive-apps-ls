// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
// Copyright (C) 2026 Robert Nisipeanu
/* aapd_conf.js — the cluster geometry Android Auto is given, in /etc/aapd.conf
 * (PATCH.md "Android Auto: the geometry").
 *
 * aapd describes its cluster display to the phone from the KOMBI_DISPLAY
 * block, for the screen size its KombiVariant maps to (aapd_patch.js
 * "screen": 12.3 on a KI_KOMBI_VARIANT 7 car): the DIMENSIONS "12.3" entry
 * and the HIGH_1080P codec definition CODEC_SUPPORTED names for it. The
 * video resolution follows CODEC_HEIGHT (480 -> 800x480, 720 -> 1280x720,
 * 1080 -> 1920x1080), the density REPORTED_SCREEN_DENSITY, and the margins
 * are
 *     left/top     = OFFSET_LEFT/TOP_TARGET_VIEWPORT
 *     right/bottom = HORIZONTAL/VERTICAL_MARGIN_SIZE - left/top
 * with the content insets the entry's safe area (SA_*PIXELS) less that
 * offset.
 *
 * The edit asks for a 1280x720 stream the phone draws whole (no margins),
 * which the decoder scales into the 1088x480 map slot, at the owner's
 * density (DENSITIES; a lower one shows more map with smaller text). The
 * safe area is the CarPlay patch's for the slot (504x368 at 286,72) at that
 * scale, so the phone keeps its turn card where the gauges leave the slot
 * clear. The numbers are replaced in place; the rest of the file stays byte
 * for byte.
 *
 * Node 8 on the unit, no dependencies. */
'use strict';

/* /etc/aapd.conf of MGU P18_23w44.2-1-3. */
var ORIGINAL_SHA256 = '9584c540f287bb79744e79cf973795208719ca798f13d881c4dac582656b0f16';

var DENSITY_MIN = 150, DENSITY_MAX = 400, DENSITY_STEP = 10, DEFAULT_DPI = 180;
var DENSITIES = [];
for (var d = DENSITY_MIN; d <= DENSITY_MAX; d += DENSITY_STEP) DENSITIES.push(d);

var CODEC = 'SCREENS/KOMBI_DISPLAY/CODEC_DEFINITION/HIGH_1080P/';
var DIMS = 'SCREENS/KOMBI_DISPLAY/DIMENSIONS/12.3/';
var BLOCK = 'SCREENS/KOMBI_DISPLAY/';

/* The stream, the part of it the phone draws in, and the safe area. */
var GEOMETRY = { codec: { w: 1280, h: 720 }, ui: { x: 0, y: 0, w: 1280, h: 720 }, safe: { x: 336, y: 108, w: 592, h: 552 } };

/* Every number in a JSON text, by its key path ("A/B/C"), with its span. */
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

/* The values the edit at dpi sets, by key path. */
function wanted(dpi) {
    var g = GEOMETRY, w = {};
    w[CODEC + 'CODEC_WIDTH'] = g.codec.w;
    w[CODEC + 'CODEC_HEIGHT'] = g.codec.h;
    w[CODEC + 'REPORTED_SCREEN_DENSITY'] = dpi;
    w[CODEC + 'REAL_SCREEN_DENSITY'] = dpi;
    w[CODEC + 'HORIZONTAL_MARGIN_SIZE'] = g.codec.w - g.ui.w;
    w[CODEC + 'VERTICAL_MARGIN_SIZE'] = g.codec.h - g.ui.h;
    w[CODEC + 'OFFSET_LEFT_TARGET_VIEWPORT'] = g.ui.x;
    w[CODEC + 'OFFSET_TOP_TARGET_VIEWPORT'] = g.ui.y;
    w[CODEC + 'WIDTH_TARGET_VIEWPORT'] = g.ui.w;
    w[CODEC + 'HEIGHT_TARGET_VIEWPORT'] = g.ui.h;
    w[DIMS + 'SA_PHYSICALDENSITY'] = dpi;
    w[DIMS + 'SA_OFFSET_LEFTPIXELS'] = g.safe.x;
    w[DIMS + 'SA_OFFSET_TOPPIXELS'] = g.safe.y;
    w[DIMS + 'SA_WIDTHPIXELS'] = g.safe.w;
    w[DIMS + 'SA_HEIGHTPIXELS'] = g.safe.h;
    w[DIMS + 'SA_WIDTH'] = mm(g.safe.w, dpi);
    w[DIMS + 'SA_HEIGHT'] = mm(g.safe.h, dpi);
    return w;
}

/* The original's text edited for dpi, or throws why it cannot be. */
function transform(text, dpi) {
    if (DENSITIES.indexOf(dpi) < 0) throw new Error('density ' + dpi + ' is not ' + DENSITY_MIN + '-' + DENSITY_MAX + ' in steps of ' + DENSITY_STEP);
    var spans = numberSpans(text), w = wanted(dpi), keys = Object.keys(w);
    keys.forEach(function (k) { if (!spans[k]) throw new Error('no ' + k); });
    keys.sort(function (a, b) { return spans[b][0] - spans[a][0]; });
    var out = text;
    keys.forEach(function (k) { out = out.slice(0, spans[k][0]) + String(w[k]) + out.slice(spans[k][1]); });
    var check = numberSpans(out);
    keys.forEach(function (k) { if (check[k][2] !== w[k]) throw new Error('edit of ' + k + ' did not take'); });
    return out;
}

/* The density of `cur` when it is the edit of `orig` at one of DENSITIES,
 * else null. */
function editedDpi(orig, cur) {
    for (var i = 0; i < DENSITIES.length; i++) {
        try { if (transform(orig, DENSITIES[i]) === cur) return DENSITIES[i]; } catch (e) { return null; }
    }
    return null;
}

/* Why `cur` is not the file `orig` is the original of, or null: the same
 * text but for numbers in the KOMBI_DISPLAY block. Independent of the
 * geometry, so any edit there of any version of this tool is undone. */
function otherFile(cur, orig) {
    var a, b;
    try { a = numberSpans(cur); } catch (e) { return 'it is not JSON (' + e.message + ')'; }
    b = numberSpans(orig);
    function masked(text, spans) {
        var keys = Object.keys(spans).sort(function (x, y) { return spans[y][0] - spans[x][0]; }), out = text;
        keys.forEach(function (k) { out = out.slice(0, spans[k][0]) + '#' + out.slice(spans[k][1]); });
        return out;
    }
    if (masked(cur, a) !== masked(orig, b)) return 'its text differs outside the numbers';
    var outside = Object.keys(a).filter(function (k) { return a[k][2] !== b[k][2] && k.indexOf(BLOCK) !== 0; });
    return outside.length ? outside[0] + ' differs' : null;
}

module.exports = {
    ORIGINAL_SHA256: ORIGINAL_SHA256, GEOMETRY: GEOMETRY, DENSITIES: DENSITIES, DEFAULT_DPI: DEFAULT_DPI,
    DENSITY_MIN: DENSITY_MIN, DENSITY_MAX: DENSITY_MAX, DENSITY_STEP: DENSITY_STEP,
    numberSpans: numberSpans, transform: transform, editedDpi: editedDpi, otherFile: otherFile,
};
