import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDecartRealtime } from '../src/lib/decart-realtime.ts';
import { createDecartTemporaryKey } from '../server/api/start-session.ts';
import { shouldNormalizeRealtimeReference } from '../src/lib/reference-image.ts';

test('Decart receives Lucy 2.5, the reference file and prompt together before first output', async () => {
  const image = new File(['portrait'], 'reference.png', { type: 'image/png' });
  const transform = { image, prompt: 'Turn the person into the reference image', enhance: false };
  let disconnected = 0;
  let connectOptions;
  const controller = new AbortController();
  const session = await connectDecartRealtime({}, 'ek_test', transform, {
    signal: controller.signal, onRemoteStream() {},
  }, ({ apiKey }) => {
    assert.equal(apiKey, 'ek_test');
    return { realtime: { connect: async (_, options) => {
      connectOptions = options;
      return { disconnect() { disconnected++; } };
    } } };
  });
  assert.equal(connectOptions.model.name, 'lucy-2.5');
  assert.deepEqual(connectOptions.initialState, { image, prompt: { text: transform.prompt, enhance: false } });
  assert.equal(connectOptions.resolution, '720p');
  session.disconnect();
  controller.abort();
  assert.equal(disconnected, 1);
});

test('cancelling during connection disconnects late SDK results and ignores late output', async () => {
  let finish;
  let options;
  let disconnected = 0;
  let outputs = 0;
  const controller = new AbortController();
  const connecting = connectDecartRealtime({}, 'ek_test', { prompt: 'test', image: null, enhance: false }, {
    signal: controller.signal, onRemoteStream() { outputs++; },
  }, () => ({ realtime: { connect: (_, value) => { options = value; return new Promise(resolve => { finish = resolve; }); } } }));
  controller.abort();
  await assert.rejects(connecting, /cancelled/);
  options.onRemoteStream({});
  finish({ disconnect() { disconnected++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disconnected, 1);
  assert.equal(outputs, 0);
});

test('Decart credentials scope the model, origin, duration and session without exposing the permanent key', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.decart.ai/v1/client/tokens');
    assert.equal(options.headers['X-API-KEY'], 'server_secret');
    assert.deepEqual(JSON.parse(options.body), {
      expiresIn: 60, allowedModels: ['lucy-2.5'], allowedOrigins: ['https://example.com'],
      constraints: { realtime: { maxSessionDuration: 42 } },
      metadata: { userId: 'user', sessionId: 'session', installationId: 'install' },
    });
    return Response.json({ apiKey: 'ek_test', expiresAt: '2026-09-30T15:00:00Z' });
  });
  const result = await createDecartTemporaryKey({ apiKey: 'server_secret', maxSeconds: 42,
    allowedOrigins: ['https://example.com'], userId: 'user', sessionId: 'session', installationId: 'install' });
  assert.equal(result.token, 'ek_test');
  assert.equal(result.sessionLimit, 42);
  assert.equal(JSON.stringify(result).includes('server_secret'), false);
});

test('Decart rejects unusable balances and never falls back to permanent keys', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ apiKey: 'secret' }); });
  assert.ok((await createDecartTemporaryKey({ apiKey: 'secret', maxSeconds: 9 })).error);
  assert.equal(calls, 0);
  assert.ok((await createDecartTemporaryKey({ apiKey: 'secret', maxSeconds: 10 })).error);
  assert.equal(calls, 1);
});

test('reference preparation accepts common images and normalizes excessive dimensions and size', () => {
  assert.equal(shouldNormalizeRealtimeReference({ type: 'image/png', size: 1024 }, 1024, 1024), false);
  assert.equal(shouldNormalizeRealtimeReference({ type: 'image/png', size: 3_000_000 }, 1024, 1024), true);
  assert.equal(shouldNormalizeRealtimeReference({ type: 'image/png', size: 1024 }, 3000, 1024), true);
});
