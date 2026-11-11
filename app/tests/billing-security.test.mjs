import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseRealtimeBilling, pcmDurationSeconds } from '../server/firebase-realtime-billing.js';

function memoryDb() {
  const rows = new Map();
  let pending = Promise.resolve();
  const snapshot = path => {
    const data = rows.get(path);
    return { id: path.split('/')[1], ref: document(path), exists: rows.has(path), data: () => data ? { ...data } : undefined };
  };
  function document(path) {
    return {
      path, id: path.split('/')[1],
      async get() { return snapshot(path); },
      async set(data) { rows.set(path, { ...data }); },
    };
  }
  function matches(query) {
    let docs = [...rows.entries()]
      .filter(([path, row]) => path.startsWith(`${query.name}/`) && (!query.field || row[query.field] === query.value))
      .map(([path]) => snapshot(path));
    if (query.take) docs = docs.slice(0, query.take);
    return { size: docs.length, docs, empty: docs.length === 0 };
  }
  function query(name, field, value) {
    const result = { name, field, value, take: undefined };
    result.limit = take => { result.take = take; return result; };
    result.get = async () => matches(result);
    return result;
  }
  return {
    collection(name) {
      return { doc: id => document(`${name}/${id}`), where: (field, _op, value) => query(name, field, value) };
    },
    runTransaction(fn) {
      const result = pending.then(() => fn({
        get: async target => target.path ? snapshot(target.path) : matches(target),
        getAll: async (...refs) => refs.map(item => snapshot(item.path)),
        update(target, change) { rows.set(target.path, { ...rows.get(target.path), ...change }); },
        set(target, data) { rows.set(target.path, { ...(rows.get(target.path) || {}), ...data }); },
        create(target, data) { if (rows.has(target.path)) throw new Error('already exists'); rows.set(target.path, { ...data }); },
      }));
      pending = result.then(() => {}, () => {});
      return result;
    },
    row: path => rows.get(path),
  };
}

async function account(db, { uid = 'user', credits = 0 } = {}) {
  await db.collection('users').doc(uid).set({ id: uid, account_status: 'active' });
  await db.collection('wallets').doc(`wallet-${uid}`).set({ id: `wallet-${uid}`, user_id: uid, credits });
}

test('zero-balance voice does not open a session and parallel converts stay unpaid', async () => {
  const db = memoryDb();
  await account(db, { credits: 0 });
  const billing = createFirebaseRealtimeBilling(db);
  const sessionId = 'voice_user_session-1';
  const opened = await billing.voice({ p_user: 'user', p_session: sessionId });
  assert.equal(opened.authorizedSeconds, 0);
  assert.equal(opened.outOfCredits, true);
  assert.equal(db.row(`translation_sessions/${sessionId}`), undefined);
  assert.deepEqual(await billing.voiceActive({ p_user: 'user', p_session: sessionId }), { active: false });
  const audioBytes = 15 * 32000;
  const results = await Promise.all([
    billing.billVoiceConvert({ p_user: 'user', p_session: sessionId, p_bytes: audioBytes, p_slot: 'a' }),
    billing.billVoiceConvert({ p_user: 'user', p_session: sessionId, p_bytes: audioBytes, p_slot: 'b' }),
  ]);
  assert.equal(results.every(result => result.accepted === false && result.outOfCredits === true), true);
  assert.equal(db.row('wallets/wallet-user').credits, 0);
});

test('a paid voice session bills each convert by audio duration and allows one grace phrase', async () => {
  const db = memoryDb();
  await account(db, { credits: 100 });
  let now = Date.parse('2026-11-11T00:00:00Z');
  const billing = createFirebaseRealtimeBilling(db, { now: () => now });
  const sessionId = 'voice_user_session-2';
  const opened = await billing.voice({ p_user: 'user', p_session: sessionId });
  assert.equal(opened.outOfCredits, false);
  assert.ok(opened.authorizedSeconds >= 1);
  assert.equal((await billing.voiceActive({ p_user: 'user', p_session: sessionId })).active, true);
  const oneSecond = await billing.billVoiceConvert({ p_user: 'user', p_session: sessionId, p_bytes: pcmDurationSeconds(32000) * 32000, p_slot: 'phrase' });
  assert.equal(oneSecond.accepted, true);
  assert.equal(db.row('wallets/wallet-user').credits, 90);
  await billing.voice({ p_user: 'user', p_session: sessionId, p_close: true });
  const grace = await billing.billVoiceConvert({ p_user: 'user', p_session: sessionId, p_bytes: 32000, p_slot: 'grace' });
  assert.equal(grace.accepted, true);
  const second = await billing.billVoiceConvert({ p_user: 'user', p_session: sessionId, p_bytes: 32000, p_slot: 'grace-2' });
  assert.equal(second.accepted, false);
});

test('silent heartbeats and closes bill server elapsed time for Plus', async () => {
  const db = memoryDb();
  await account(db, { credits: 100 });
  let now = Date.parse('2026-11-11T00:00:00Z');
  const billing = createFirebaseRealtimeBilling(db, { now: () => now });
  await db.collection('sessions').doc('plus').set({
    id: 'plus', user_id: 'user', status: 'active', billing_version: 2, video_rate_half: 4,
    provider: 'xmax', provider_max_seconds: 7200, seconds_used: 0, start_time: new Date(now).toISOString(),
    credential_expires_at: new Date(now + 180000).toISOString(),
  });
  const reserved = await billing.reserveVideo({ p_user: 'user', p_session: 'plus', p_window: 180 });
  assert.equal(reserved.reservedSeconds, 50);
  assert.equal(db.row('wallets/wallet-user').credits, 0);
  now += 20000;
  const silent = await billing.video({ p_user: 'user', p_session: 'plus', p_epoch_seconds: [], p_close: false });
  assert.equal(silent.shouldStop, false);
  assert.equal(silent.totalBillableSeconds, 20);
  assert.equal(silent.remainingCredits, 60);
  const late = await billing.video({ p_user: 'user', p_session: 'plus', p_epoch_seconds: [Math.floor(now / 1000) - 121], p_close: false });
  assert.equal(late.shouldStop, false);
  now += 10000;
  const closed = await billing.video({ p_user: 'user', p_session: 'plus', p_epoch_seconds: [], p_close: true });
  assert.equal(closed.ended, true);
  assert.equal(closed.totalBillableSeconds, 30);
  assert.equal(db.row('wallets/wallet-user').credits, 40);
  assert.equal(db.row('sessions/plus').status, 'ended');
});

test('a second streaming session cannot stay active on the same balance', async () => {
  const db = memoryDb();
  await account(db, { credits: 400 });
  const now = Date.parse('2026-11-11T00:00:00Z');
  const billing = createFirebaseRealtimeBilling(db, { now: () => now });
  await db.collection('sessions').doc('first').set({
    id: 'first', user_id: 'user', status: 'active', billing_version: 2, video_rate_half: 5,
    provider: 'vidu', provider_max_seconds: 7200, seconds_used: 0, start_time: new Date(now).toISOString(),
  });
  const first = await billing.reserveVideo({ p_user: 'user', p_session: 'first', p_window: 180 });
  assert.ok(first.reservedSeconds >= 1);
  await db.collection('sessions').doc('second').set({
    id: 'second', user_id: 'user', status: 'active', billing_version: 2, video_rate_half: 5,
    provider: 'vidu', provider_max_seconds: 7200, seconds_used: 0, start_time: new Date(now).toISOString(),
  });
  await assert.rejects(billing.reserveVideo({ p_user: 'user', p_session: 'second', p_window: 180 }), /Another streaming session is active/);
  assert.equal(db.row('sessions/second').status, 'active');
  const balanceAfterFirst = db.row('wallets/wallet-user').credits;
  await assert.rejects(billing.video({ p_user: 'user', p_session: 'second', p_epoch_seconds: [], p_close: false }), /Another streaming session is active/);
  assert.equal(db.row('wallets/wallet-user').credits, balanceAfterFirst);
});

test('Plus keeps one prepaid key for field clients and revokes it when the heartbeat stops', async () => {
  const db = memoryDb();
  await account(db, { credits: 1000 });
  let now = Date.parse('2026-11-11T00:00:00Z');
  const billing = createFirebaseRealtimeBilling(db, { now: () => now });
  await db.collection('sessions').doc('plus-long').set({
    id: 'plus-long', user_id: 'user', status: 'active', billing_version: 2, video_rate_half: 4,
    provider: 'xmax', provider_max_seconds: 1800, seconds_used: 0, start_time: new Date(now).toISOString(),
    provider_key_id: 'tk-field-client',
  });
  const reserved = await billing.reserveVideo({ p_user: 'user', p_session: 'plus-long', p_window: 1800 });
  assert.equal(reserved.reservedSeconds, 500);
  assert.equal(db.row('wallets/wallet-user').credits, 0);
  await db.collection('sessions').doc('plus-long').set({
    ...db.row('sessions/plus-long'),
    credential_expires_at: new Date(now + 500000).toISOString(),
  });
  for (let minute = 0; minute < 6; minute += 1) {
    now += 60000;
    const beat = await billing.video({ p_user: 'user', p_session: 'plus-long', p_epoch_seconds: [], p_close: false });
    assert.equal(beat.ended, false, 'a field client that keeps polling is not cut off');
  }
  now += 40000;
  const stillGoing = await billing.video({ p_user: 'user', p_session: 'plus-long', p_epoch_seconds: [], p_close: false });
  assert.equal(stillGoing.shouldStop, false);
  assert.equal(stillGoing.ended, false);
  assert.equal(stillGoing.totalBillableSeconds, 400);
  assert.equal(stillGoing.remainingCredits, 200);
  assert.equal(db.row('sessions/plus-long').provider_key_id, 'tk-field-client');
  now += 91000;
  const missed = await billing.video({ p_user: 'user', p_session: 'plus-long', p_epoch_seconds: [], p_close: false });
  assert.equal(missed.ended, true);
  assert.equal(missed.reason, 'heartbeat_timeout');
  assert.equal(missed.totalBillableSeconds, 490);
  assert.equal(db.row('wallets/wallet-user').credits, 20);
  assert.equal(db.row('sessions/plus-long').status, 'ended');
});

test('closing without a client timestamp still bills a long gap in commit-sized chunks', async () => {
  const db = memoryDb();
  await account(db, { credits: 1000 });
  let now = Date.parse('2026-11-11T00:00:00Z');
  const billing = createFirebaseRealtimeBilling(db, { now: () => now });
  await db.collection('sessions').doc('long').set({
    id: 'long', user_id: 'user', status: 'active', billing_version: 2, video_rate_half: 4,
    provider: 'xmax', provider_max_seconds: 7200, seconds_used: 0, start_time: new Date(now).toISOString(),
    credential_expires_at: new Date(now + 180000).toISOString(),
  });
  await billing.reserveVideo({ p_user: 'user', p_session: 'long', p_window: 180 });
  now += 121000;
  const first = await billing.video({ p_user: 'user', p_session: 'long', p_epoch_seconds: [], p_close: true });
  assert.equal(first.billingIncomplete, true);
  assert.equal(first.ended, false);
  const second = await billing.video({ p_user: 'user', p_session: 'long', p_epoch_seconds: [], p_close: true });
  assert.equal(second.ended, true);
  assert.equal(second.totalBillableSeconds, 121);
});
