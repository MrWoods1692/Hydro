#!/usr/bin/env node
// Re-assert the system domain avatar (school badge) on every start.
'use strict';
const { withSystemConfig } = require('./lib-hydro-config');

withSystemConfig(async (coll) => {
    // No upsert: Hydro itself creates the system domain on first boot; this just
    // re-asserts the avatar on later starts (start-hydro.sh replays it).
    const domains = coll.db.collection('domain');
    await domains.updateOne({ _id: 'system' }, { $set: { avatar: '/img/guiguang-school-badge.png' } });
    console.log('[set-domain-avatar] system domain avatar -> school badge');
}).catch((e) => {
    console.error('[set-domain-avatar] failed:', e);
    process.exit(1);
});
