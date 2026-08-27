import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listSystemLogs,
  listUserAccountHistory,
} from '../../shared/admin-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function createSupabase(tables, authUsers = []) {
  return {
    auth: {
      admin: {
        async listUsers({ page }) {
          return { data: { users: page === 1 ? authUsers : [] }, error: null };
        },
      },
    },
    from(tableName) {
      const source = tables[tableName];
      const filters = [];
      let ordering = null;
      const builder = {
        select() { return builder; },
        eq(column, value) { filters.push((row) => row[column] === value); return builder; },
        gte(column, value) { filters.push((row) => String(row[column] || '') >= String(value)); return builder; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return builder; },
        order(column, options = {}) { ordering = { column, ascending: options.ascending !== false }; return builder; },
        async range(from, to) {
          if (source?.error) return { data: null, error: source.error };
          let rows = [...(source || [])].filter((row) => filters.every((filter) => filter(row)));
          if (ordering) {
            const direction = ordering.ascending ? 1 : -1;
            rows.sort((left, right) => String(left[ordering.column] || '').localeCompare(String(right[ordering.column] || '')) * direction);
          }
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
      return builder;
    },
  };
}

test('per-user account history merges durable sources without leaking another user or duplicating purchases', async () => {
  const supabase = createSupabase({
    admin_audit_logs: [
      { id: 'audit-credit', admin_user_id: ADMIN_ID, action: 'credits.added', target_type: 'user', target_id: USER_ID, reason: 'Support adjustment', created_at: minutesAgo(4) },
      { id: 'audit-status', admin_user_id: ADMIN_ID, action: 'user.suspended', target_type: 'user', target_id: USER_ID, reason: 'Chargeback review', created_at: minutesAgo(3) },
      { id: 'audit-other', admin_user_id: ADMIN_ID, action: 'user.suspended', target_type: 'user', target_id: OTHER_USER_ID, reason: 'Must not leak', created_at: minutesAgo(2) },
    ],
    wallet_ledger: [
      { id: 'ledger-adjust', user_id: USER_ID, transaction_id: null, delta: -20, balance_after: 80, entry_type: 'admin_adjustment', reason: 'Credit correction', actor_user_id: ADMIN_ID, created_at: minutesAgo(2) },
      { id: 'ledger-purchase', user_id: USER_ID, transaction_id: 'tx-1', delta: 100, balance_after: 100, entry_type: 'package_purchase', reason: 'Verified payment', actor_user_id: null, created_at: minutesAgo(5) },
      { id: 'ledger-other', user_id: OTHER_USER_ID, transaction_id: null, delta: 500, balance_after: 500, entry_type: 'admin_adjustment', reason: 'Must not leak', actor_user_id: ADMIN_ID, created_at: minutesAgo(1) },
    ],
    transactions: [
      { id: 'tx-1', user_id: USER_ID, type: 'credit_purchase', status: 'success', amount_naira: 2300, credits: 100, reference: 'MORPHLY_TEST', payment_gateway: 'flutterwave', created_at: minutesAgo(5), verified_at: minutesAgo(4) },
      { id: 'tx-other', user_id: OTHER_USER_ID, type: 'credit_purchase', status: 'success', amount_naira: 9999, credits: 999, reference: 'OTHER', created_at: minutesAgo(1) },
    ],
  }, [
    { id: USER_ID, email: 'customer@example.com' },
    { id: OTHER_USER_ID, email: 'other@example.com' },
    { id: ADMIN_ID, email: 'owner@example.com' },
  ]);

  const result = await listUserAccountHistory(supabase, { userId: USER_ID, limit: 100 });
  const ids = result.entries.map((entry) => entry.id);

  assert.deepEqual(result.dataHealth, {
    adminAuditAvailable: true,
    walletLedgerAvailable: true,
    transactionsAvailable: true,
    truncated: false,
  });
  assert.ok(ids.includes('audit:audit-status'));
  assert.ok(ids.includes('ledger:ledger-adjust'));
  assert.ok(ids.includes('transaction:tx-1'));
  assert.ok(!ids.includes('audit:audit-credit'), 'the matching ledger is the canonical credit adjustment');
  assert.ok(!ids.includes('ledger:ledger-purchase'), 'a linked purchase is represented once by its transaction');
  assert.ok(result.entries.every((entry) => !entry.detail.includes('Must not leak')));
  assert.equal(result.entries.find((entry) => entry.id === 'ledger:ledger-adjust').actor, 'owner@example.com');
});

test('per-user account history rejects an invalid user identifier before querying data', async () => {
  await assert.rejects(
    listUserAccountHistory(createSupabase({}), { userId: 'not-a-uuid' }),
    /valid userId/i,
  );
});

test('system logs merge errors, analytics, sessions, payments, and admin actions with user attribution', async () => {
  const supabase = createSupabase({
    error_logs: [{
      id: 1,
      fingerprint: 'video-error',
      error_code: 'VIDEO_ERROR',
      safe_message: 'Video generation failed safely',
      user_id: USER_ID,
      platform: 'windows',
      severity: 'error',
      occurrences: 2,
      first_seen_at: minutesAgo(8),
      last_seen_at: minutesAgo(2),
    }],
    analytics_events: [{ id: 1, event_name: 'first_frame_received', user_id: USER_ID, platform: 'windows', acquisition_source: 'direct', created_at: minutesAgo(7) }],
    admin_audit_logs: [{ id: 'audit-1', admin_user_id: ADMIN_ID, action: 'user.suspended', target_type: 'user', target_id: USER_ID, reason: 'Security review', created_at: minutesAgo(1) }],
    sessions: [{ id: 'session-1', user_id: USER_ID, status: 'ended', created_at: minutesAgo(6), end_time: minutesAgo(5) }],
    transactions: [{ id: 'tx-1', user_id: USER_ID, type: 'credit_purchase', status: 'success', amount_naira: 2300, credits: 100, payment_gateway: 'flutterwave', created_at: minutesAgo(4), verified_at: minutesAgo(3) }],
  }, [
    { id: USER_ID, email: 'customer@example.com' },
    { id: ADMIN_ID, email: 'owner@example.com' },
  ]);

  const logs = await listSystemLogs(supabase, { days: 30 });
  const events = new Set(logs.map((entry) => entry.event));

  assert.ok(events.has('VIDEO_ERROR'));
  assert.ok(events.has('FIRST_FRAME_RECEIVED'));
  assert.ok(events.has('SESSION_ENDED'));
  assert.ok(events.has('PAYMENT_SUCCESS'));
  assert.ok(events.has('USER.SUSPENDED'));
  assert.ok(logs.length >= 5, 'an error row must not suppress the other durable event sources');
  assert.ok(logs.every((entry) => entry.user === 'customer@example.com'));
  assert.equal(logs.find((entry) => entry.event === 'VIDEO_ERROR').severity, 'critical');
  assert.equal(logs.find((entry) => entry.event === 'PAYMENT_SUCCESS').record_source, 'transactions');
});

test('system logs still report per-user operational activity when optional log tables are unavailable', async () => {
  const missingTable = { error: { code: '42P01', message: 'relation does not exist' } };
  const supabase = createSupabase({
    error_logs: missingTable,
    analytics_events: missingTable,
    admin_audit_logs: missingTable,
    sessions: [{ id: 'session-1', user_id: USER_ID, status: 'active', created_at: minutesAgo(1) }],
    transactions: [],
  }, [{ id: USER_ID, email: 'customer@example.com' }]);

  const logs = await listSystemLogs(supabase, { days: 30 });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'SESSION_ACTIVE');
  assert.equal(logs[0].user, 'customer@example.com');
  assert.equal(logs[0].record_source, 'sessions');
});

test('platform filtering keeps directly attributed errors even without an analytics identity', async () => {
  const supabase = createSupabase({
    error_logs: [{
      id: 7,
      fingerprint: 'windows-startup-error',
      error_code: 'STARTUP_ERROR',
      safe_message: 'Startup failed before user identification',
      user_id: null,
      platform: 'windows',
      severity: 'error',
      occurrences: 1,
      first_seen_at: minutesAgo(2),
      last_seen_at: minutesAgo(1),
    }],
    analytics_events: [],
    admin_audit_logs: [],
    sessions: [],
    transactions: [],
  });

  const logs = await listSystemLogs(supabase, { days: 30, platform: 'windows' });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'STARTUP_ERROR');
  assert.equal(logs[0].platform, 'windows');
  assert.equal(logs[0].user_id, null);
});
