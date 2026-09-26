#!/usr/bin/env node
// Apply Campux OAuth plugin config into Hydro's system config from env vars
// (CAMPUX_OAUTH_*) or scripts/env.campux (start-hydro.sh sources it).
// Required for the login-with-campux plugin (Config schema requires id/secret).
'use strict';
const path = require('path');
const yaml = require('js-yaml');
const { withSystemConfig } = require('./lib-hydro-config');

withSystemConfig(async (coll, cfg) => {
    // Local file storage under the fork's data dir (default /data needs root).
    cfg.file = { type: 'file', path: path.resolve(__dirname, '..', 'data', 'file') };
    // Note: the login-with-campux plugin config is NOT stored here — the fork's
    // worker.ts applies it directly from CAMPUX_OAUTH_* env vars.
    await coll.updateOne({ _id: 'config' }, { $set: { value: yaml.dump(cfg) } }, { upsert: true });
    console.log('[apply-brand-settings] brand / storage config applied');
}).catch((e) => {
    console.error('[apply-brand-settings] failed:', e);
    process.exit(1);
});
