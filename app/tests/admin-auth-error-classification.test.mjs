import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateRequestUser } from '../../shared/admin-auth.js';

const request = { headers: { authorization: 'Bearer test-token' } };
function client(error, provider = 'firebase') {
  return { provider, auth: { getUser: async token => {
    assert.equal(token, 'test-token');
    return { data: null, error };
  } }, from: () => assert.fail('Failed authentication must not query account data') };
}

test('Firebase infrastructure failures return 503 without exposing their details', async () => {
  const result = await authenticateRequestUser(request, client({ status: 503, code: 'auth/insufficient-permission', message: 'private credential details' }));
  assert.equal(result.status, 503);
  assert.match(result.error, /temporarily unavailable/);
  assert.equal(JSON.stringify(result).includes('private credential details'), false);
});

test('invalid Firebase tokens still return 401', async () => {
  assert.deepEqual(await authenticateRequestUser(request, client({ status: 401, code: 'auth/id-token-expired' })),
    { error: 'Invalid or expired access token', status: 401 });
});

test('non-Firebase errors retain the existing authentication behavior', async () => {
  assert.equal((await authenticateRequestUser(request, client({ status: 503 }, 'other'))).status, 401);
});
