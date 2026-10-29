import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUsersCsv, escapeCsvField, handleAdminUsersExport, isSensitiveKey } from '../../shared/admin-users-export.js';

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
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
  assert.equal(escapeCsvField(42), '42');
});

test('users CSV includes profile fields but never secrets', () => {
  assert.ok(isSensitiveKey('password_hash'));
  assert.ok(isSensitiveKey('refresh_token'));
  const csv = buildUsersCsv(
    [{ id: 'u1', email: 'a@b.com', name: 'Ann, B', credits: 10, plan: 'Credits', status: 'active' }],
    new Map([['u1', { id: 'u1', onboarding_version: 1, password_hash: 'x', api_key: 'y' }]]),
  );
  const [header, row] = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.match(header, /^uid,email,display_name,created_at,last_sign_in_at,credits,plan/);
  assert.match(header, /profile_onboarding_version/);
  assert.doesNotMatch(csv, /password|api_key/);
  assert.match(row, /^u1,a@b\.com,"Ann, B",/);
});

test('export rejects missing tokens and non-admin callers', async () => {
  const noToken = fakeRes();
  await handleAdminUsersExport({ headers: {} }, noToken, {});
  assert.equal(noToken.statusCode, 401);

  const supabaseAdmin = {
    auth: { getUser: async () => ({ data: { user: { id: 'buyer' } }, error: null }) },
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
      return query;
    },
  };
  const nonAdmin = fakeRes();
  await handleAdminUsersExport({ headers: { authorization: 'Bearer t' } }, nonAdmin, supabaseAdmin);
  assert.equal(nonAdmin.statusCode, 403);
});
