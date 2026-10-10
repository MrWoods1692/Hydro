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
    // 存储后端选择，凭据文件都在 data/ 下且不进 git：
    //   1) data/.storage_to.json  -> storage.to（R2 + 分享链接）
    //   2) data/.webdav.cred      -> WebDAV
    //   3) 都没有                 -> 保持库里已有配置不动（绝不默认改写成本地磁盘）
    const storageToCred = path.resolve(__dirname, '.storage_to.json');
    const credPath = path.resolve(__dirname, '.webdav.cred');
    if (fs.existsSync(storageToCred)) {
        const cred = JSON.parse(fs.readFileSync(storageToCred, 'utf8'));
        cfg.file = {
            type: 'storage_to',
            token: cred.token,
            secret: cred.secret || (cfg.file && cfg.file.secret) || 'hydro_file_secret_2026',
            // 切换前写在本地的历史文件（题目评测数据 / 旧上传）仍需可读，保留本地兜底目录
            legacyPath: cred.legacyPath || '/data/file/hydro',
            endPointForUser: '/fs/',
            endPointForJudge: '/fs/',
        };
    } else if (fs.existsSync(credPath)) {
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
        console.log('[apply-brand-settings] no storage credential file (.storage_to.json / .webdav.cred) — keeping existing file config');
    }
    // Note: the login-with-campux plugin config is NOT stored here — the fork's
    // worker.ts applies it directly from CAMPUX_OAUTH_* env vars.
    await coll.updateOne({ _id: 'config' }, { $set: { value: yaml.dump(cfg) } }, { upsert: true });
    console.log('[apply-brand-settings] brand / storage config applied');
}).catch((e) => {
    console.error('[apply-brand-settings] failed:', e);
    process.exit(1);
});
