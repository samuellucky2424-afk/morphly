import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accumulateLedger, accumulateSession, accumulateTransaction, buildSummaryHeader, csvRow,
  escapeCsvField, handleAdminUsersExport, isSensitiveKey, stripSecrets, summaryValues,
} from '../../shared/admin-users-export.js';

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    write(chunk) { this.body += chunk; }, end() { this.ended = true; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  };
}

test('CSV fields are escaped and protected against formula injection', () => {
  assert.equal(escapeCsvField('plain'), 'plain');
  assert.equal(escapeCsvField('a,b'), '"a,b"');
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(escapeCsvField('+1'), "'+1");
  assert.equal(escapeCsvField('-2'), "'-2");
  assert.equal(escapeCsvField('@cmd'), "'@cmd");
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField({ a: 1, token: 's' }), '"{""a"":1}"');
  assert.equal(csvRow(['a', 'b,c']), 'a,"b,c"\r\n');
});

test('secrets are stripped from keys and nested objects', () => {
  for (const key of ['password_hash', 'refresh_token', 'api_key', 'client_secret']) assert.ok(isSensitiveKey(key));
  assert.ok(!isSensitiveKey('onboarding_version'));
  assert.deepEqual(stripSecrets({ role: 'x', nested: { secret: 1, ok: 2 } }), { role: 'x', nested: { ok: 2 } });
});

test('all-time summary aggregates purchases, credits and sessions', () => {
  const stats = undefined;
  const s = {
    purchases: 0, spentByCurrency: {}, firstPurchaseAt: null, lastPurchaseAt: null, latestPlan: null, latestPlanAt: null,
    transactions: 0, failedPayments: 0, refunds: 0, paymentGateways: new Set(), creditsBought: 0, creditsUsed: 0, creditsGranted: 0,
    creditsRemoved: 0, ledgerEntries: 0, sessions: 0, successfulSessions: 0, sessionSeconds: 0, sessionCredits: 0, lastSessionAt: null,
    providers: new Set(), sessionPlatforms: new Set(), platforms: new Set(), referralsMade: 0, referralsQualified: 0,
  };
  accumulateTransaction(s, { type: 'purchase', status: 'success', amount_naira: 5000, created_at: '2025-01-01T00:00:00Z', package_name_snapshot: 'Starter' });
  accumulateTransaction(s, { type: 'purchase', status: 'success', amount_naira: 9000, created_at: '2026-01-01T00:00:00Z', package_name_snapshot: 'Pro' });
  accumulateTransaction(s, { type: 'purchase', status: 'failed', amount_naira: 1 });
  accumulateLedger(s, { delta: 100, entry_type: 'package_purchase' });
  accumulateLedger(s, { delta: -30, entry_type: 'ai_session_usage' });
  accumulateLedger(s, { delta: 20, entry_type: 'signup_bonus' });
  accumulateSession(s, { status: 'completed', seconds_used: 15, cost: 30, created_at: '2026-02-01T00:00:00Z' });
  accumulateSession(s, { status: 'failed', seconds_used: 0, cost: 0 });
  assert.equal(s.purchases, 2); assert.equal(s.spentByCurrency.NGN, 14000); assert.equal(s.failedPayments, 1);
  assert.equal(s.latestPlan, 'Pro'); assert.equal(s.firstPurchaseAt, '2025-01-01T00:00:00.000Z');
  assert.equal(s.creditsBought, 100); assert.equal(s.creditsUsed, 30); assert.equal(s.creditsGranted, 20);
  assert.equal(s.sessions, 2); assert.equal(s.successfulSessions, 1); assert.equal(s.sessionSeconds, 15);

  const header = buildSummaryHeader(['profile_onboarding_version', 'wallet_balance']);
  const row = summaryValues({ uid: 'u1', email: 'a@b.com', emailVerified: true, providerData: [{ providerId: 'google.com' }], customClaims: { admin: true, token: 'x' }, metadata: {} },
    s, { profile: { onboarding_version: 2 }, wallet: { credits: 90, balance: 0 } }, ['profile_onboarding_version', 'wallet_balance']);
  const record = Object.fromEntries(header.map((h, i) => [h, row[i]]));
  assert.equal(record.current_credits, 90); assert.equal(record.auth_providers, 'google.com');
  assert.deepEqual(record.custom_claims, { admin: true }); assert.equal(record.profile_onboarding_version, 2);
  assert.equal(record.session_success_rate_pct, 50); assert.equal(stats, undefined);
});

test('export rejects missing tokens and non-admin callers', async () => {
  const noToken = fakeRes();
  await handleAdminUsersExport({ headers: {} }, noToken, {});
  assert.equal(noToken.statusCode, 401);
  const supabaseAdmin = {
    auth: { getUser: async () => ({ data: { user: { id: 'buyer' } }, error: null }) },
    from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; return q; },
  };
  const nonAdmin = fakeRes();
  await handleAdminUsersExport({ headers: { authorization: 'Bearer t' } }, nonAdmin, supabaseAdmin);
  assert.equal(nonAdmin.statusCode, 403);
});
