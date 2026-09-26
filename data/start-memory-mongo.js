#!/usr/bin/env node
// In-memory MongoDB for local dev (mongodb-memory-server).
// Writes ~/.hydro/config.json (db url) and ~/.hydro/addon.json, then keeps running.
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
    const mongod = await MongoMemoryServer.create();
    const url = mongod.getUri('hydro').replace(/\/$/, '');

    const configPath = path.resolve(os.homedir(), '.hydro', 'config.json');
    fs.ensureDirSync(path.dirname(configPath));
    // Delete any stale config from an interrupted previous run so start-all.sh's
    // wait loop actually waits for THIS mongo instance.
    fs.removeSync(configPath);
    fs.writeFileSync(configPath, JSON.stringify({ url }, null, 2));

    // Addons enabled for this fork. login-with-campux and checkin are NOT listed:
    // the fork's worker.ts registers them directly from env vars (listing them
    // here would register their services twice and crash on boot).
    const addonPath = path.resolve(os.homedir(), '.hydro', 'addon.json');
    fs.writeFileSync(addonPath, JSON.stringify([
        '@hydrooj/ui-default',
        '@hydrooj/hydrojudge',
    ], null, 2));

    console.log(`[memory-mongo] ready: ${url}`);
    console.log(`[memory-mongo] wrote ${configPath} and ${addonPath}`);
    // Keep this process (and the mongod child) alive until killed.
    setInterval(() => {}, 1000);
})().catch((e) => {
    console.error('[memory-mongo] failed:', e);
    process.exit(1);
});
