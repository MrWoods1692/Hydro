#!/usr/bin/env node
// 创建一个测试管理员账号，便于端到端验证签到流程。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MongoClient } = require('mongodb');

const UNAME = '测试管理员';
const PASSWORD = 'Test1234!';
const SALT = 'testadmin123';

function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, 100000, 64, 'sha256', (err, key) => {
            if (err) reject(err);
            else resolve(key.toString('hex').substring(0, 64));
        });
    });
}

(async () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(os.homedir(), '.hydro', 'config.json'), 'utf8'));
    const client = new MongoClient(cfg.url, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db();
    const users = db.collection('user');
    const dusers = db.collection('domain.user');

    const hash = await hashPassword(PASSWORD, SALT);

    const existing = await users.findOne({ uname: UNAME });
    let uid;
    if (existing) {
        uid = existing._id;
        await users.updateOne({ _id: uid }, { $set: { priv: 999999, salt: SALT, hash, hashType: 'hydro' } });
        console.log(`[admin] existing user ${UNAME} (uid ${uid}) reset to admin`);
    } else {
        const maxDoc = await users.find({}, { _id: 1 }).sort({ _id: -1 }).limit(1).toArray();
        const maxId = maxDoc.length ? maxDoc[0]._id : 0;
        uid = maxId + 1;
        const now = new Date();
        const doc = {
            _id: uid, uname: UNAME, unameLower: UNAME.toLowerCase(),
            mail: 'admin@test.local', mailLower: 'admin@test.local',
            salt: SALT, hash, hashType: 'hydro',
            priv: 999999, regat: now, loginat: now, firstLogin: now,
            tfa: false, authn: false, domains: [], theme: 'light',
            fontFamily: 'Open Sans', codeFont: 'Source Code Pro', codeLang: 'cpp17',
            gender: 0, formatCode: true, showTimeAgo: true, join: true,
            bio: '测试管理员', rp: 0, nAccept: 0, ip: ['127.0.0.1'],
        };
        await users.insertOne(doc);
        await dusers.insertOne({
            _id: `${UNAME.toLowerCase()}_system_${uid}`, domainId: 'system', uid,
            uname: UNAME, unameLower: UNAME.toLowerCase(), mail: doc.mail, mailLower: doc.mailLower,
            role: 'default', perm: '0', group: [], rp: 0, nAccept: 0,
            lastActive: now, rpInfo: {},
        });
        console.log(`[admin] created user ${UNAME} uid=${uid}`);
    }
    await client.close();
    console.log(`LOGIN: ${UNAME} / ${PASSWORD}`);
})().catch((e) => { console.error('failed:', e); process.exit(1); });
