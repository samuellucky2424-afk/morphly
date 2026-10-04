import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { createTranslationHttpServer } from '../server/translation-http-server.js';
import { resolveTranslationGatewayUrl } from '../server/translation-config.js';
import publicConfig from '../server/api/public-config.ts';

const env = { VERCEL: '1', VERCEL_ENV: 'production', GEMINI_API_KEY: 'private-test-key',
  VERCEL_PROJECT_PRODUCTION_URL: 'app.example.com', VERCEL_URL: 'preview.example.com' };

test('Vercel selects its production URL and isolates preview deployments', () => {
  assert.equal(resolveTranslationGatewayUrl(env), 'wss://app.example.com/api/translation/live');
  assert.equal(resolveTranslationGatewayUrl({ ...env, VERCEL_ENV: 'preview' }), 'wss://preview.example.com/api/translation/live');
  assert.equal(resolveTranslationGatewayUrl({ ...env, VERCEL_PROJECT_PRODUCTION_URL: '' }), 'wss://preview.example.com/api/translation/live');
  assert.equal(resolveTranslationGatewayUrl({ ...env, TRANSLATION_GATEWAY_URL: ' wss://relay.example/live ' }), 'wss://relay.example/live');
});

test('missing keys and untrusted URLs cannot publish a built-in translation destination', () => {
  assert.equal(resolveTranslationGatewayUrl({ ...env, GEMINI_API_KEY: ' ' }), '');
  assert.equal(resolveTranslationGatewayUrl({ ...env, VERCEL: '' }), '');
  for (const host of ['https://attacker.test', 'app.test@attacker.test', 'app.test/path', 'app.test?x=1']) {
    assert.equal(resolveTranslationGatewayUrl({ ...env, VERCEL_PROJECT_PRODUCTION_URL: host }), '');
  }
});

test('public config publishes the relay URL without exposing Gemini credentials or trusting request hosts', async t => {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const override = process.env.TRANSLATION_GATEWAY_URL;
  delete process.env.TRANSLATION_GATEWAY_URL;
  t.after(() => { if (override !== undefined) process.env.TRANSLATION_GATEWAY_URL = override; });
  let body;
  await publicConfig({ method: 'GET', headers: { host: 'attacker.test', 'x-forwarded-host': 'attacker.test' } }, {
    setHeader() {}, status(code) { assert.equal(code, 200); return this; }, json(data) { body = data; },
  });
  assert.equal(body.translationGatewayUrl, 'wss://app.example.com/api/translation/live');
  assert.ok(!JSON.stringify(body).includes(env.GEMINI_API_KEY));
});

async function serve(t, options) {
  const server = createTranslationHttpServer(options);
  assert.equal(server.listening, false);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP health reports missing credentials without calling Gemini or billing', async t => {
  const url = await serve(t, {});
  const response = await fetch(`${url}/api/translation/live`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).configured, false);
});

test('configured endpoint serves health and WebSocket upgrades, rejecting invalid tokens before Gemini', async t => {
  const url = await serve(t, { apiKey: 'private-test-key',
    supabase: { auth: { getUser: async () => ({ error: true }) } },
    createUpstream() { assert.fail('Unauthenticated request opened Gemini'); },
  });
  const response = await fetch(`${url}/api/translation/live`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true, transport: 'websocket' });
  assert.equal((await fetch(`${url}/missing`)).status, 404);
  assert.equal((await fetch(`${url}/api/translation/live`, { method: 'POST' })).status, 405);
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/translation/live`);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const reply = once(socket, 'message');
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ type: 'auth', accessToken: 'invalid-test-token', targetLanguage: 'es' }));
  const [data] = await reply;
  assert.match(JSON.parse(data.toString()).message, /sign-in/);
  await closed;
});

test('both Vercel project roots deploy the WebSocket server with sufficient duration', async () => {
  for (const root of ['../', '../../']) {
    const config = JSON.parse(await readFile(new URL(`${root}vercel.json`, import.meta.url), 'utf8'));
    assert.equal(config.functions['api/translation/live.ts'].maxDuration, 300);
    const route = await import(new URL(`${root}api/translation/live.ts`, import.meta.url));
    assert.equal(typeof route.default.listen, 'function');
    assert.equal(route.default.listening, false);
  }
});
