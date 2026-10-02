#!/usr/bin/env node
// Seed demo users so the /ranking table has rows to render.
// Writes directly to the Mongo pointed at by ~/.hydro/config.json (no source files touched).
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const USERS = [
    { uname: '林一舟', rp: 2840, nAccept: 137, bio: 'C++ 爱好者，喜欢图论。' },
    { uname: '苏晚晴', rp: 2765, nAccept: 128, bio: 'OIer / 数论怪人' },
    { uname: '陈嘉禾', rp: 2702, nAccept: 121, bio: 'dp 写得飞快' },
    { uname: '周子墨', rp: 2618, nAccept: 114, bio: 'string 选手' },
    { uname: '王梓萱', rp: 2544, nAccept: 107, bio: '线段树狂魔' },
    { uname: '李思远', rp: 2489, nAccept: 101, bio: '模拟退火选手' },
    { uname: '黄沐宸', rp: 2401, nAccept: 96, bio: '喜欢暴力枚举' },
    { uname: '徐若彤', rp: 2322, nAccept: 88, bio: '树状数组爱好者' },
    { uname: '何雨欣', rp: 2248, nAccept: 83, bio: '二分查找永不迟。' },
    { uname: '罗天佑', rp: 2176, nAccept: 77, bio: '背包问题专家' },
    { uname: '宋亦辰', rp: 2090, nAccept: 71, bio: 'STL 熟练工' },
    { uname: '邓嘉懿', rp: 1985, nAccept: 64, bio: '正在学网络流' },
];

(async () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(os.homedir(), '.hydro', 'config.json'), 'utf8'));
    const client = new MongoClient(cfg.url, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db();
    const users = db.collection('user');
    const dusers = db.collection('domain.user');

    let maxId = 0;
    for (const doc of await users.find({}, { _id: 1 }).sort({ _id: -1 }).limit(1).toArray()) {
        maxId = doc._id || 0;
    }
    if (maxId >= 2) {
        console.log(`[seed-demo-users] ${maxId} users already present, skipping`);
        await client.close();
        return;
    }

    const now = new Date();
    const docs = USERS.map((u, i) => ({
        _id: maxId + 1 + i,
        uname: u.uname,
        unameLower: u.uname.toLowerCase(),
        mail: `${u.uname}@demo.local`,
        mailLower: `${u.uname}@demo.local`,
        salt: 'demo',
        hash: '',
        hashType: 'hydro',
        priv: 1,
        regat: new Date(now.getTime() - (i + 1) * 86400000),
        loginat: new Date(now.getTime() - i * 3600000),
        firstLogin: new Date(now.getTime() - (i + 1) * 86400000),
        tfa: false,
        authn: false,
        domains: [],
        theme: 'light',
        fontFamily: 'Open Sans',
        codeFont: 'Source Code Pro',
        codeLang: 'cpp17',
        gender: 0,
        formatCode: true,
        showTimeAgo: true,
        join: true,
        bio: u.bio,
        rp: u.rp,
        nAccept: u.nAccept,
        ip: ['127.0.0.1'],
    }));

    await users.insertMany(docs);
    await dusers.insertMany(docs.map((u) => ({
        _id: `${u.uname.toLowerCase()}_system_${u._id}`,
        domainId: 'system',
        uid: u._id,
        uname: u.uname,
        unameLower: u.unameLower,
        mail: u.mail,
        mailLower: u.mailLower,
        role: 'default',
        perm: '0',
        group: [],
        rp: u.rp,
        nAccept: u.nAccept,
        lastActive: new Date(now.getTime() - u._id * 60000),
        rpInfo: {},
    })));

    console.log(`[seed-demo-users] inserted ${docs.length} users (ids ${maxId + 1}..${maxId + docs.length})`);
    await client.close();
})().catch((e) => {
    console.error('[seed-demo-users] failed:', e);
    process.exit(1);
});
