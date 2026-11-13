import test from 'node:test';
import assert from 'node:assert/strict';
import { planConnectChargeRefund } from '../scripts/refund-failed-connect.mjs';

const userId = 'user-1';

test('a connect that billed without a first frame is refunded, and a framed session is not', () => {
  const plan = planConnectChargeRefund({
    userId,
    sessions: [
      { id: 'charged', user_id: userId, provider: 'vidu', seconds_used: 20, end_reason: 'no_credits', start_time: '2026-11-13T00:00:00.000Z', end_time: '2026-11-13T00:00:21.000Z' },
      { id: 'watched', user_id: userId, provider: 'vidu', seconds_used: 12 },
      { id: 'empty', user_id: userId, provider: 'vidu', seconds_used: 0 },
    ],
    events: [{ event_name: 'first_frame_received', session_id: 'watched', user_id: userId }],
    ledger: [
      { user_id: userId, entry_type: 'realtime_usage', delta: -25, created_at: '2026-11-13T00:00:10.000Z' },
      { user_id: userId, entry_type: 'realtime_usage', delta: -25, created_at: '2026-11-13T00:00:20.000Z' },
      { user_id: userId, entry_type: 'realtime_usage', delta: -40, created_at: '2026-11-12T00:00:00.000Z' },
      { user_id: userId, entry_type: 'signup_bonus', delta: 50 },
    ],
  });
  assert.deepEqual(plan.affectedSessionIds, ['charged']);
  assert.equal(plan.chargedCredits, 50);
  assert.equal(plan.refundCredits, 50);
  assert.equal(plan.write, false);
});

test('nothing is refunded when every billed session delivered a frame', () => {
  const plan = planConnectChargeRefund({
    userId,
    sessions: [{ id: 'watched', user_id: userId, seconds_used: 8 }],
    events: [{ event_name: 'first_frame_received', session_id: 'watched' }],
    ledger: [{ user_id: userId, entry_type: 'realtime_usage', delta: -20 }],
  });
  assert.deepEqual(plan.affectedSessionIds, []);
  assert.equal(plan.refundCredits, 0);
});
