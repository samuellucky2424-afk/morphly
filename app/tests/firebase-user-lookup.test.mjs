import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseUserLookup } from '../server/firebase-user-lookup.js';

function harness() {
  const logs = [];
  const calls = [];
  const auth = {
    verifyIdToken: async (token, checkRevoked) => { calls.push(['verify', token, checkRevoked]); return { uid: 'test-user' }; },
    getUser: async uid => { calls.push(['user', uid]); return { uid }; },
  };
  const options = { auth, mapUser: async record => { calls.push(['profile', record.uid]); return { id: record.uid }; },
    logger: value => logs.push(value) };
  return { auth, options, calls, logs };
}

test('Firebase lookup verifies revocation before reading account and profile', async () => {
  const h = harness();
  assert.deepEqual(await createFirebaseUserLookup(h.options)('fixture-token'), { data: { user: { id: 'test-user' } }, error: null });
  assert.deepEqual(h.calls, [['verify', 'fixture-token', true], ['user', 'test-user'], ['profile', 'test-user']]);
  assert.deepEqual(h.logs, []);
});

test('expired and revoked tokens cannot reach account data', async () => {
  for (const code of ['auth/id-token-expired', 'auth/id-token-revoked']) {
    const h = harness();
    h.auth.verifyIdToken = async () => { throw Object.assign(new Error('private token value'), { code }); };
    const result = await createFirebaseUserLookup(h.options)('private token value');
    assert.equal(result.error.status, 401);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.logs, [{ stage: 'verify_token', code }]);
    assert.equal(JSON.stringify([h.logs, result]).includes('private token value'), false);
  }
});

test('credential and certificate failures are backend failures, including SDK invalid-argument wrapping', async () => {
  for (const code of ['auth/insufficient-permission', 'app/invalid-credential', 'auth/invalid-argument']) {
    const h = harness();
    h.auth.verifyIdToken = async () => { throw Object.assign(new Error('Credential failure: private certificate content'), { code }); };
    const result = await createFirebaseUserLookup(h.options)('fixture-token');
    assert.equal(result.error.status, 503);
    assert.deepEqual(h.logs, [{ stage: 'verify_token', code }]);
    assert.equal(JSON.stringify([h.logs, result]).includes('private certificate content'), false);
  }
});

test('Firestore profile failures retain backend status and identify the failing stage safely', async () => {
  const h = harness();
  h.options.mapUser = async () => { throw Object.assign(new Error('Private profile data'), { code: 7 }); };
  assert.equal((await createFirebaseUserLookup(h.options)('fixture-token')).error.status, 503);
  assert.deepEqual(h.logs, [{ stage: 'load_profile', code: '7' }]);
  assert.equal(JSON.stringify(h.logs).includes('Private profile data'), false);
});

test('account lookup permission failures report load_user without logging user identifiers', async () => {
  const h = harness();
  h.auth.getUser = async () => { throw Object.assign(new Error('private account'), { code: 'auth/insufficient-permission' }); };
  assert.equal((await createFirebaseUserLookup(h.options)('fixture-token')).error.status, 503);
  assert.deepEqual(h.logs, [{ stage: 'load_user', code: 'auth/insufficient-permission' }]);
  assert.equal(JSON.stringify(h.logs).includes('test-user'), false);
});

test('unrecognized error codes are redacted and logger failures do not change the result', async () => {
  const h = harness();
  h.auth.verifyIdToken = async () => { throw { code: 'private-token-value' }; };
  assert.equal((await createFirebaseUserLookup(h.options)('fixture-token')).error.code, 'unknown');
  h.options.logger = () => { throw new Error('Logger unavailable'); };
  assert.equal((await createFirebaseUserLookup(h.options)('fixture-token')).error.status, 503);
});
