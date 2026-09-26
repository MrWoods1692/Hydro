#!/usr/bin/env node
// Re-assert the site name on every start (in-memory Mongo loses data on restart).
'use strict';
const yaml = require('js-yaml');
const { withSystemConfig } = require('./lib-hydro-config');

withSystemConfig(async (coll, cfg) => {
    cfg.server = { ...(cfg.server || {}), name: '奎光' };
    await coll.updateOne({ _id: 'config' }, { $set: { value: yaml.dump(cfg) } }, { upsert: true });
    console.log('[set-site-name] server.name = 奎光');
}).catch((e) => {
    console.error('[set-site-name] failed:', e);
    process.exit(1);
});
