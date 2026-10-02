#!/usr/bin/env node
// 为指定用户签发一个持久 token（用于本地验证，绕过 campux OAuth 禁用密码登录）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoClient } = require('mongodb');

const UNAME = '测试管理员';

(async () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(os.homedir(), '.hydro', 'config.json'), 'utf8'));
    const client = new MongoClient(cfg.url, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db();

    // 找一个有 hydro token 签名的方式：hydro 用 crypto.randomBytes + secret 签 token。
    // 简化：直接用 model.token 无法脱离 ctx。改用 session token 表。
    // HydroOJ 的 TokenModel.TYPE_SESSION 存在 collection 'token'，_id 是随机 token。
    const udoc = await db.collection('user').findOne({ uname: UNAME });
    if (!udoc) { console.error('user not found'); await client.close(); process.exit(1); }

    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    const uid = udoc._id;

    await db.collection('token').deleteMany({ token });
    await db.collection('token').insertOne({
        _id: 'token',
        token: token,
        uid: uid,
        type: 2,            // TYPE_SESSION = 2
        data: { ip: '127.0.0.1' },
        createdAt: new Date(),
        expireAt: new Date(Date.now() + 7 * 86400000),
        scope: 999999,
    });

    console.log('TOKEN=' + token);
    console.log('UID=' + uid);
    console.log('COOKIE=Hydro=' + token);
    await client.close();
})().catch((e) => { console.error('failed:', e); process.exit(1); });
