#!/usr/bin/env node
// 启用账号密码登录（system config 里 server.login = true）。
'use strict';
const yaml = require('js-yaml');
const { withSystemConfig } = require('./lib-hydro-config');

withSystemConfig(async (coll, cfg) => {
    cfg.server = { ...(cfg.server || {}), login: true };
    await coll.updateOne({ _id: 'config' }, { $set: { value: yaml.dump(cfg) } }, { upsert: true });
    console.log('[set-login] server.login = true');
}).catch((e) => {
    console.error('[set-login] failed:', e);
    process.exit(1);
});
