import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalPreviewRequest } from '../server/local-preview.js';
import startSession, { createViduTemporaryKey } from '../server/api/start-session.ts';

test('preview requires an explicit development flag and a direct loopback request', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  const env = { NODE_ENV: 'development', LOCAL_PREVIEW: 'true' };
  assert.equal(isLocalPreviewRequest(req, env), true);
  for (const override of [{ NODE_ENV: 'production' }, { NODE_ENV: undefined }, { LOCAL_PREVIEW: 'false' }, { VERCEL: '1' }]) {
    assert.equal(isLocalPreviewRequest(req, { ...env, ...override }), false);
  }
  assert.equal(isLocalPreviewRequest({ ...req, socket: { remoteAddress: '192.0.2.1' } }, env), false);
  assert.equal(isLocalPreviewRequest({ ...req, headers: { 'x-forwarded-for': '192.0.2.1' } }, env), false);
  assert.equal(isLocalPreviewRequest({ body: { userId: '00000000-0000-0000-0000-000000000001' } }, env), false);
});

test('Vidu never substitutes the permanent API key for a client credential', async (t) => {
  const permanentKey = 'test-server-only-key';
  const oldMock = process.env.VIDU_MOCK;
  delete process.env.VIDU_MOCK;
  t.after(() => { if (oldMock === undefined) delete process.env.VIDU_MOCK; else process.env.VIDU_MOCK = oldMock; });
  for (const data of [{ live: { id: 'test-live' }, rtc: { token: 'rtc-only' } }, { token: permanentKey }]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(data), { status: 200 }));
    const result = await createViduTemporaryKey({ apiKey: permanentKey, maxSeconds: 60, sessionId: 'test-session', imageUrl: 'https://example.com/reference.png' });
    assert.equal(result.error.error, 'VIDU_CLIENT_CREDENTIAL_MISSING');
    assert.equal(JSON.stringify(result).includes(permanentKey), false);
    t.mock.restoreAll();
  }
});

test('Vidu creation sends the selected image and bare server authorization, returns scoped credentials', async (t) => {
  const apiKey = 'vda_server-only-test';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).pathname, '/live/s_editing/realtime');
    assert.equal(options.headers.Authorization, apiKey);
    assert.deepEqual(JSON.parse(options.body), { image_url: 'https://example.com/my-image.png', editing_type: 'subject_replacement' });
    return Response.json({ client_secret: 'session-secret', live: { id: 'live-1', live_duration: 90, trace_id: 'trace-1' }, render_uid: 'render-1', rtc: { user_id: 'user-1', token: 'rtc-auth' } });
  });
  const result = await createViduTemporaryKey({ apiKey, maxSeconds: 1800, imageUrl: 'https://example.com/my-image.png', editingType: 'background_replacement' });
  assert.equal(result.token, 'session-secret');
  assert.equal(result.liveId, 'live-1');
  assert.equal(result.sessionLimit, 90);
  assert.equal(result.rtc.token, 'rtc-auth');
  assert.equal(result.traceId, 'trace-1');
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('Vidu creates fresh credential pairs and returns the same regional host used for creation', async (t) => {
  const previousBase = process.env.VIDU_API_BASE_URL;
  t.after(() => {
    if (previousBase === undefined) delete process.env.VIDU_API_BASE_URL;
    else process.env.VIDU_API_BASE_URL = previousBase;
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).origin, process.env.VIDU_API_BASE_URL);
    calls++;
    return Response.json({ client_secret: `secret-${calls}`, live: { id: `live-${calls}` },
      render_uid: `render-${calls}`, rtc: { user_id: `user-${calls}`, token: `rtc-${calls}` } });
  });
  for (const baseUrl of ['https://api.vidu.com', 'https://api.vidu.cn']) {
    process.env.VIDU_API_BASE_URL = baseUrl;
    const result = await createViduTemporaryKey({ apiKey: 'test-server-key', maxSeconds: 60, imageUrl: 'https://example.com/image.png' });
    assert.equal(result.liveId, `live-${calls}`);
    assert.equal(result.token, `secret-${calls}`);
    assert.equal(result.rtc.token, `rtc-${calls}`);
    assert.equal(result.baseUrl, baseUrl);
  }
  assert.equal(calls, 2);
});

test('Vidu preserves the provider expiry and rejects expired or ended creation responses', async (t) => {
  const tokenExpiry = Math.floor(Date.now() / 1000) + 7200;
  let response = { client_secret: 'session-secret', live: { id: 'live-1', status: 'waiting' },
    render_uid: 'renderer', rtc: { user_id: 'camera-user', token: 'rtc-auth', token_expire_at: String(tokenExpiry) } };
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  const create = () => createViduTemporaryKey({ apiKey: 'test-server-key', maxSeconds: 60, imageUrl: 'https://example.com/image.png' });
  assert.equal((await create()).expiresAt, new Date(tokenExpiry * 1000).toISOString());
  response.rtc.token_expire_at = String(Math.floor(Date.now() / 1000) - 1);
  assert.equal((await create()).error.error, 'VIDU_SESSION_EXPIRED');
  response.rtc.token_expire_at = String(tokenExpiry);
  response.live.status = 'ended';
  assert.equal((await create()).error.error, 'VIDU_SESSION_ENDED');
});

test('removed Pro engine is rejected before creating or billing a provider session', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Provider must not be contacted'); });
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await startSession({method:'POST',headers:{},body:{provider:'decart'}},res);
  assert.equal(res.code,400);
  assert.equal(res.body.allowed,false);
  assert.match(res.body.error,/Only Plus subject replacement/);
});

test('Vidu does not create sessions without an image or retry ambiguous provider failures', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}, { status: 500 }); });
  assert.equal((await createViduTemporaryKey({ apiKey: 'test', maxSeconds: 60 })).error.error, 'INVALID_REFERENCE_IMAGE');
  assert.equal(calls, 0);
  await createViduTemporaryKey({ apiKey: 'test', maxSeconds: 60, imageUrl: 'https://example.com/image.png' });
  assert.equal(calls, 1);
});
