import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseOperations } from '../server/firebase-operations.js';
import { createMemoryFirestore } from './helpers/memory-firestore.mjs';
import { planUnreturnedHolds } from '../scripts/find-unreturned-holds.mjs';
import { formatCreditBalance } from '../src/lib/credit-balance.ts';

test('signing in returns a stranded hold without resetting or duplicating the wallet', async () => {
  const db = createMemoryFirestore();
  const ops = createFirebaseOperations(db, {});
  await ops.provision({ id: 'user', email: 'user@example.com' });
  const before = await db.collection('wallets').where('user_id', '==', 'user').get();
  assert.equal(before.size, 1);
  assert.equal(before.docs[0].data().credits, 50);
  await before.docs[0].ref.update({ credits: 0 });
  await db.collection('sessions').doc('stuck').set({
    id: 'stuck', user_id: 'user', status: 'ended', reserved_half: 900, video_rate_half: 4, end_reason: 'account_suspended',
  });
  await ops.provision({ id: 'user', email: 'user@example.com' });
  const after = await db.collection('wallets').where('user_id', '==', 'user').get();
  assert.equal(after.size, 1);
  assert.equal(after.docs[0].data().credits, 450);
  assert.equal((await db.collection('sessions').doc('stuck').get()).data().reserved_half, 0);
  await ops.provision({ id: 'user', email: 'user@example.com' });
  const twice = await db.collection('wallets').where('user_id', '==', 'user').get();
  assert.equal(twice.size, 1);
  assert.equal(twice.docs[0].data().credits, 450);
});

test('signing in during a live hold reports the balance and leaves the stream running', async () => {
  const db = createMemoryFirestore();
  const ops = createFirebaseOperations(db, {});
  await db.collection('users').doc('user').set({ id: 'user', account_status: 'active', referral_code: 'ABCDEF23' });
  await db.collection('wallets').doc('wallet').set({ id: 'wallet', user_id: 'user', credits: 0 });
  await db.collection('sessions').doc('live').set({
    id: 'live', user_id: 'user', status: 'active', billing_version: 2, video_rate_half: 4,
    provider: 'xmax', reserved_half: 160, last_heartbeat_at: new Date().toISOString(),
    start_time: new Date().toISOString(),
  });
  await ops.provision({ id: 'user', email: 'user@example.com' });
  assert.equal((await db.collection('sessions').doc('live').get()).data().status, 'active');
  assert.equal((await db.collection('wallets').doc('wallet').get()).data().credits, 0);
  assert.equal(await ops.rpc('realtime_wallet_balance', { p_user: 'user' }), 80);
});

test('the hold checklist separates a live hold, a quiet connect, and a stranded end', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const plan = planUnreturnedHolds({
    userId: 'user',
    wallets: [
      { user_id: 'user', credits: 0 },
      { user_id: 'user', credits: 20 },
      { user_id: 'other', credits: 999 },
    ],
    now,
    sessions: [
      { id: 'live', user_id: 'user', status: 'active', reserved_half: 40, last_heartbeat_at: new Date(now - 1000).toISOString() },
      { id: 'quiet', user_id: 'user', status: 'active', reserved_half: 100, start_time: new Date(now - 120000).toISOString() },
      { id: 'streamed', user_id: 'user', status: 'active', reserved_half: 80, output_started_epoch: 1, last_heartbeat_at: new Date(now - 120000).toISOString() },
      { id: 'stranded', user_id: 'user', status: 'ended', reserved_half: 60 },
      { id: 'clear', user_id: 'user', status: 'ended', reserved_half: 0 },
      { id: 'foreign', user_id: 'other', status: 'ended', reserved_half: 500 },
    ],
  });
  assert.equal(plan.write, false);
  assert.equal(plan.duplicateWallets, true);
  assert.equal(plan.walletCredits, 20);
  assert.equal(plan.displayedWithoutHold, 20);
  assert.equal(plan.hiddenCredits, 140);
  assert.equal(plan.balanceIncludingHolds, 160);
  assert.deepEqual(plan.holds.map(hold => [hold.sessionId, hold.kind, hold.action]), [
    ['live', 'live_hold', 'keep_on_session'],
    ['quiet', 'stale_no_output', 'return_hold'],
    ['streamed', 'stale_with_output', 'bill_output_then_return_rest'],
    ['stranded', 'ended_stranded', 'return_hold'],
  ]);
});

test('a missing user id cannot produce a refund plan', () => {
  assert.throws(() => planUnreturnedHolds({ sessions: [{ reserved_half: 10 }] }), /userId/);
});

test('the credit display stays blank until a balance has loaded', () => {
  assert.equal(formatCreditBalance(0, false), '…');
  assert.equal(formatCreditBalance(0, true), '0');
  assert.equal(formatCreditBalance(80.5, true), '81');
  assert.equal(formatCreditBalance(Number.NaN, true), '…');
});
