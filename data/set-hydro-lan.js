#!/usr/bin/env node
// Set server.url to this machine's LAN address so Campux OAuth redirect_uri works
// from any host on the LAN (start-hydro.sh replays this on every start).
'use strict';
const os = require('os');
const yaml = require('js-yaml');
const { withSystemConfig } = require('./lib-hydro-config');

function lanIPv4() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces || []) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

withSystemConfig(async (coll, cfg) => {
    const url = `http://${lanIPv4()}:8888/`;
    cfg.server = { ...(cfg.server || {}), url };
    await coll.updateOne({ _id: 'config' }, { $set: { value: yaml.dump(cfg) } }, { upsert: true });
    console.log(`[set-hydro-lan] server.url = ${url}`);
}).catch((e) => {
    console.error('[set-hydro-lan] failed:', e);
    process.exit(1);
});
