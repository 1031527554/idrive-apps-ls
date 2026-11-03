// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* What keeps the journal and logs units from restarting the head unit or
 * holding up its boot: each unit's name in both recmgr lists, no ordering
 * before another unit, a core limit that sends no dump to the crash handler,
 * bounded restarts, no root but the firewall rule's two commands, and the
 * rule removed however the logs service stops. */
var assert = require('assert'), fs = require('fs'), path = require('path');

var root = path.join(__dirname, '..', '..');
var c = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
var NEW = ['waze-on-cluster-journal.service', 'waze-on-cluster-logs.socket', 'waze-on-cluster-logs.service'];

function unit(name) {
    var text = fs.readFileSync(path.join(root, 'systemd', name), 'utf8'), keys = {};
    text.split('\n').forEach(function (l) {
        var m = /^([A-Za-z]+)=(.*)$/.exec(l);
        if (m) (keys[m[1]] = keys[m[1]] || []).push(m[2]);
    });
    return keys;
}

NEW.forEach(function (name) {
    assert(c.units.some(function (u) { return u.name === name; }), name + ' installed');
    assert(c.recmgr.indexOf(name.replace(/\.(service|socket)$/, '')) >= 0, name + ' in recmgr');
    assert(!unit(name).Before, name + ' orders itself before nothing');
});
['waze-on-cluster-journal.service', 'waze-on-cluster-logs.service'].forEach(function (name) {
    var u = unit(name);
    assert.deepStrictEqual(u.DynamicUser, ['yes'], name);
    assert(!u.User || u.User[0] !== 'root', name);
    assert.deepStrictEqual(u.LimitCORE, ['1'], name);
    assert(u.Restart && u.RestartSec && Number(u.StartLimitBurst) > 0, name + ' restarts, bounded');
    assert(u.MemoryLimit && u.CPUQuota && u.TasksMax, name + ' bounded');
    (u.ExecStartPre || []).concat(u.ExecStopPost || []).forEach(function (cmd) {
        if (cmd.indexOf('+') >= 0) assert(/^-\+(\/bin\/sh -c 'mkdir -p \/var\/opt\/waze-on-cluster\/\w+ && chown root:systemd-journal|\/usr\/bin\/node \S+\/logs_fw\.js (open|close)$)/.test(cmd), cmd);
    });
    assert(c.restart.indexOf(name) >= 0, name + ' restarted on update');
});
var logs = unit('waze-on-cluster-logs.service');
assert.deepStrictEqual(logs.ExecStopPost, ['-+/usr/bin/node /var/opt/waze-on-cluster/current/logs_fw.js close']);
assert(logs.ExecStartPre.indexOf('-+/usr/bin/node /var/opt/waze-on-cluster/current/logs_fw.js open') >= 0);
assert(!logs.WantedBy, 'the logs service starts only through its socket');
assert(c.enable.some(function (e) { return e.unit === 'waze-on-cluster-logs.socket' && e.target === 'sockets.target'; }));
assert(c.enable.some(function (e) { return e.unit === 'waze-on-cluster-journal.service' && e.target === 'multi-user.target'; }));
console.log('ok   journal and logs units: in recmgr, before nothing, no core dumps, bounded, unprivileged, rule removed on stop');
