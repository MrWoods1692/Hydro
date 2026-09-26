#!/usr/bin/env node
// Shared helper: load ~/.hydro/config.json, open Mongo, read/write the system config
// document (collection "system", _id "config", YAML text in field "value").
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { MongoClient } = require('mongodb');

function loadDbConfig() {
    const file = path.resolve(os.homedir(), '.hydro', 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function withSystemConfig(fn) {
    const dbConfig = loadDbConfig();
    const client = new MongoClient(dbConfig.url, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    try {
        const coll = client.db().collection('system');
        const doc = await coll.findOne({ _id: 'config' });
        const cfg = (doc && yaml.load(doc.value)) || {};
        await fn(coll, cfg);
    } finally {
        await client.close();
    }
}

module.exports = { withSystemConfig, loadDbConfig };
