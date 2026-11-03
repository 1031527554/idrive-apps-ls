// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs_fw.js against a stand-in nft holding ip filter input: open leaves
 * exactly one tagged rule at the top, also over rules a stopped page left;
 * close removes every tagged rule and nothing else; a unit without the chain
 * gets nothing; an nft failure is an error. */
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
var fw = require('../logs_fw.js');

/* chain: null (no such chain) or [{ handle, text }], top first */
function fakeNft(chain) {
    var next = 100, calls = [];
    function nft(args) {
        calls.push(args.join(' '));
        var a = args.join(' ');
        if (!chain) {
            var e = new Error('nft: Error: No such file or directory'); e.absent = true;
            return Promise.reject(e);
        }
        if (a === '-a list chain ip filter input') {
            return Promise.resolve('table ip filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy drop;\n' +
                chain.map(function (r) { return '\t\t' + r.text + ' # handle ' + r.handle + '\n'; }).join('') + '\t}\n}\n');
        }
        var m = /^delete rule ip filter input handle (\d+)$/.exec(a);
        if (m) {
            var i = chain.findIndex(function (r) { return String(r.handle) === m[1]; });
            if (i < 0) return Promise.reject(new Error('no rule ' + m[1]));
            chain.splice(i, 1);
            return Promise.resolve('');
        }
        m = /^insert rule ip filter input (.*)$/.exec(a);
        if (m) { chain.unshift({ handle: next++, text: m[1] }); return Promise.resolve(''); }
        return Promise.reject(new Error('unexpected nft ' + a));
    }
    nft.calls = calls;
    return nft;
}

var RULE = 'iifname "wlan_bridge" tcp dport 8475 accept comment "waze-on-cluster-logs"';

(async function () {
    var chain = [{ handle: 5, text: 'ct state established,related accept' },
        { handle: 6, text: RULE }, { handle: 7, text: 'iifname "lo" accept' }, { handle: 8, text: RULE }];
    var nft = fakeNft(chain);
    await fw.open(nft);
    assert.deepStrictEqual(chain.map(function (r) { return r.text; }),
        [RULE, 'ct state established,related accept', 'iifname "lo" accept'], 'one tagged rule, at the top');
    console.log('ok   open: the rules a stopped page left are removed, one rule inserted at the top');

    await fw.open(nft);
    assert.strictEqual(chain.filter(function (r) { return r.text === RULE; }).length, 1, 'open twice: still one');
    await fw.close(nft);
    assert.deepStrictEqual(chain.map(function (r) { return r.text; }), ['ct state established,related accept', 'iifname "lo" accept']);
    await fw.close(nft);
    console.log('ok   close: every tagged rule removed, the others kept; closing again changes nothing');

    var none = fakeNft(null);
    await fw.open(none);
    await fw.close(none);
    assert(!none.calls.some(function (c) { return /^(insert|delete)/.test(c); }), 'nothing written without the chain');
    console.log('ok   a unit without ip filter input: nothing to do, no error');

    var failing = function () { return Promise.reject(new Error('nft: Operation not permitted')); };
    await fw.open(failing).then(function () { throw new Error('resolved'); }, function (e) { assert(/not permitted/.test(e.message)); });
    console.log('ok   an nft failure is an error');

    /* the command line, with nft as a script */
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfw-')), script = path.join(dir, 'nft'), log = path.join(dir, 'log');
    fs.writeFileSync(script, '#!/bin/sh\necho "$@" >> ' + log + '\n' +
        'case "$*" in "-a list chain ip filter input") echo \'\t\t' + RULE + ' # handle 9\';; esac\n');
    fs.chmodSync(script, 0o755);
    var r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'logs_fw.js'), 'close'],
        { env: Object.assign({}, process.env, { WOC_NFT: script }), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert(/delete rule ip filter input handle 9/.test(fs.readFileSync(log, 'utf8')));
    assert.strictEqual(cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'logs_fw.js'), 'wide-open']).status, 2);
    cp.execFileSync('rm', ['-rf', dir]);
    console.log('ok   logs_fw.js close removes the tagged rule; an unknown action is refused');
    console.log('logs_fw: all passed');
})().catch(function (e) { console.error('FAIL', e && e.stack); process.exit(1); });
