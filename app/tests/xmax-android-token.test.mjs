import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createXmaxAndroidKey} from '../server/xmax-android-token.js';

test('temporary credential is limited by the authorized session and never returns the server key', async () => {
  let sent;
  const result = await createXmaxAndroidKey({apiKey: 'server-secret', maxSeconds: 30,
    fetchImpl: async (url, request) => {
      sent = {url, body: JSON.parse(request.body)};
      return {ok: true, json: async () => ({success: true, data: {temporaryApiKey: 'temporary-only'}})};
    }});
  assert.equal(sent.url, 'https://api.xmax.cloud/open/api/v1/temporary-api-key');
  assert.deepEqual(sent.body, {expireSeconds: 150, pointsLimit: 30});
  assert.equal(result.token, 'temporary-only');
  assert.equal(result.sessionLimit, 30);
});

test('provider failures and echoed permanent credentials fail closed without exposing secrets', async () => {
  for (const [ok, token] of [[false, 'temporary'], [true, 'server-secret'], [true, null]]) {
    const result = await createXmaxAndroidKey({apiKey: 'server-secret', maxSeconds: 60,
      fetchImpl: async () => ({ok, status: 401, json: async () => ({data: {temporaryApiKey: token}, message: 'server-secret'})})});
    assert.ok(result.error);
    assert.equal(JSON.stringify(result).includes('server-secret'), false);
  }
});
