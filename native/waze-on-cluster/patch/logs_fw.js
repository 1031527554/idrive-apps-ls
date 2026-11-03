#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs_fw — the firewall rule that lets a phone on the car's hotspot reach
 * the logs page. waze-on-cluster-logs.service runs it as root before the
 * page starts (open) and after it stops, however it stopped (close).
 *
 *   node logs_fw.js open    removes every rule tagged COMMENT, then inserts
 *                           at the top of ip filter input:
 *                           iifname "wlan_bridge" tcp dport 8475 accept comment "waze-on-cluster-logs"
 *   node logs_fw.js close   removes every rule tagged COMMENT
 *
 * The unit's firewall (firewalldz) drops what its input chain does not
 * accept; replies leave through its output chain's accept of established
 * connections. A unit without that table or chain gets nothing and is no
 * error. Exits 1 when nft fails.
 *
 * Node 8 on the unit. No dependencies.
 */
var cp = require('child_process');

var COMMENT = 'waze-on-cluster-logs';
var IFACE = 'wlan_bridge';
var PORT = 8475;

function execNft(args) {
    return new Promise(function (resolve, reject) {
        cp.execFile(process.env.WOC_NFT || 'nft', args, { timeout: 15000, maxBuffer: 4 << 20 }, function (err, out, stderr) {
            if (!err) { resolve(out); return; }
            var e = new Error('nft ' + args.join(' ') + ': ' + (String(stderr || '').trim() || err.message));
            e.absent = /No such file or directory/.test(String(stderr));
            reject(e);
        });
    });
}

/* Handles of the tagged rules in ip filter input; null without that chain. */
function tagged(nft) {
    return nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']).then(function (out) {
        return out.split('\n').filter(function (l) { return l.indexOf('comment "' + COMMENT + '"') >= 0; })
            .map(function (l) { return /# handle (\d+)\s*$/.exec(l); }).filter(Boolean)
            .map(function (m) { return m[1]; });
    }, function (err) {
        if (err.absent) return null;
        throw err;
    });
}

/* Removes the tagged rules; resolves the chain's presence. */
function close(nft) {
    nft = nft || execNft;
    return tagged(nft).then(function (handles) {
        return (handles || []).reduce(function (p, h) {
            return p.then(function () { return nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', h]); });
        }, Promise.resolve()).then(function () { return handles !== null; });
    });
}

function open(nft) {
    nft = nft || execNft;
    return close(nft).then(function (present) {
        if (!present) return;
        return nft(['insert', 'rule', 'ip', 'filter', 'input', 'iifname', '"' + IFACE + '"', 'tcp', 'dport', String(PORT),
            'accept', 'comment', '"' + COMMENT + '"']);
    });
}

if (require.main === module) {
    var what = process.argv[2];
    var run = what === 'open' ? open : what === 'close' ? close : null;
    if (!run) { console.error('usage: logs_fw.js open|close'); process.exit(2); }
    run().then(function () { process.exit(0); }, function (err) { console.error('logs_fw: ' + err.message); process.exit(1); });
}

module.exports = { open: open, close: close, COMMENT: COMMENT, IFACE: IFACE, PORT: PORT };
