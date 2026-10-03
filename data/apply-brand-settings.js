#!/usr/bin/env node
// Apply Campux OAuth plugin config into Hydro's system config from env vars
// (CAMPUX_OAUTH_*) or scripts/env.campux (start-hydro.sh sources it).
// Required for the login-with-campux plugin (Config schema requires id/secret).
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { withSystemConfig } = require('./lib-hydro-config');

withSystemConfig(async (coll, cfg) => {
    // WebDAV storage if the local credential file is present (it is gitignored);
    // otherwise fall back to local file storage under the fork's data dir.
    const credPath = path.resolve(__dirname, '.webdav.cred');
    if (fs.existsSync(credPath)) {
        const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        cfg.file = {
            type: 'webdav',
            endPoint: cred.endPoint,
            username: cred.username,
            password: cred.password,
            endPointForUser: '/',
            endPointForJudge: '/',
        };
        // Per-user quota for the WebDAV-backed store (1 TiB by default,
        // overridable via USER_FILES_QUOTA_BYTES for testing).
        const quota = Number(process.env.USER_FILES_QUOTA_BYTES) || 1024 ** 4;
        await coll.updateOne({ _id: 'limit.user_files_size' }, { $set: { value: quota } });
        await coll.updateOne({ _id: 'limit.user_files' }, { $set: { value: 10000 } });
    } else {
        cfg.file = { type: 'file', path: path.resolve(__dirname, '..', 'data', 'file') };
    }
    // Note: the login-with-campux plugin config is NOT stored here — the fork's
    // worker.ts applies it directly from CAMPUX_OAUTH_* env vars.
    await coll.updateOne({ _id: 'config' }, { $set: { value: yaml.dump(cfg) } }, { upsert: true });
    console.log('[apply-brand-settings] brand / storage config applied');
}).catch((e) => {
    console.error('[apply-brand-settings] failed:', e);
    process.exit(1);
});
