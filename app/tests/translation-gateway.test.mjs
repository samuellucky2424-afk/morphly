import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { attachTranslationGateway } from '../server/translation-gateway.js';
import { connectTranslation } from '../server/translation-client.js';
import { validateTranslationOptions, validateTranslationRouting } from '../shared/translation.js';

const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
async function fixture(t, overrides = {}, gatewayOptions = {}) {
  const upstreams = [], billing = [], received = [], errors = [], states = [];
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const supabase = {
    auth: { getUser: async token => token === 'valid-test-token' ? { data: { user: { id: 'test-user' } } } : { error: true } },
    rpc: async (_name, args) => { billing.push(args); return { data: { authorizedSeconds: args.p_seconds, remainingCredits: 1000 } }; },
    ...overrides,
  };
  const gateway = attachTranslationGateway(server, { supabase, apiKey: 'server-secret', createUpstream: () => {
    const upstream = new EventEmitter(); upstream.readyState = WebSocket.OPEN; upstream.bufferedAmount = 0;
    upstream.messages = [];
    upstream.send = text => {
      const message = JSON.parse(text); upstream.messages.push(message);
      if (message.setup) queueMicrotask(() => upstream.emit('message', Buffer.from('{"setupComplete":{}}')));
      if (message.realtimeInput) queueMicrotask(() => upstream.emit('message', Buffer.from(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }] } } }))));
    };
    upstream.terminate = () => { upstream.readyState = WebSocket.CLOSED; upstream.emit('close'); };
    upstreams.push(upstream); queueMicrotask(() => upstream.emit('open')); return upstream;
  }, ...gatewayOptions });
  const client = connectTranslation({ gatewayUrl: `ws://127.0.0.1:${server.address().port}/api/translation/live`, accessToken: 'valid-test-token', targetLanguage: 'es', incoming: true, onAudio: message => received.push(message), onError: message => errors.push(message), onState: state => states.push(state), retryBaseMs: 10 });
  t.after(async () => { client.close(); for (const socket of gateway.clients) socket.terminate(); gateway.close(); await new Promise(resolve => server.close(resolve)); });
  return { client, upstreams, billing, received, errors, states };
}

test('two-way PCM travels client -> authenticated gateway -> Gemini -> client; billing starts with audio', async t => {
  const f = await fixture(t); await f.client.ready;
  assert.equal(f.billing.length, 0);
  assert.equal(f.upstreams[0].messages[0].setup.generationConfig.translationConfig.targetLanguageCode, 'es');
  assert.equal(f.upstreams[1].messages[0].setup.generationConfig.translationConfig.targetLanguageCode, 'en');
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  f.client.send({ type: 'audio', direction: 'incoming', data: 'AAAAAA==' });
  await waitFor(() => f.received.length === 2);
  assert.deepEqual(f.received.map(message => message.direction).sort(), ['incoming', 'outgoing']);
  assert.ok(f.received.every(message => message.sampleRate === 24000));
  assert.equal(f.billing[0].p_seconds, 5);
  f.client.close(); await waitFor(() => f.billing.some(call => call.p_close));
  assert.ok(f.billing.at(-1).p_seconds <= 1);
});

test('billing failure closes both directions without forwarding microphone audio', async t => {
  const f = await fixture(t, { rpc: async () => ({ error: true }) }); await f.client.ready;
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.errors.length > 0);
  assert.ok(f.upstreams.every(socket => !socket.messages.some(message => message.realtimeInput)));
  assert.match(f.errors[0], /credits/);
});

test('temporary credit service outage reconnects without sending unauthorized audio', async t => {
  let attempts = 0;
  const f = await fixture(t, { rpc: async (_name, args) => {
    if (!args.p_close && ++attempts === 1) return { status: 0, error: { message: 'Network timeout' } };
    return { data: { authorizedSeconds: args.p_seconds } };
  } });
  await f.client.ready;
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.upstreams.length === 4 && f.upstreams[2].messages.some(message => message.realtimeInput));
  assert.ok(f.upstreams.slice(0, 2).every(socket => !socket.messages.some(message => message.realtimeInput)));
  assert.deepEqual(f.errors, []);
});

test('host session deadline settles credits and automatically reconnects both directions', async t => {
  let lifetime, settled = false;
  const f = await fixture(t, {}, {
    maxSessionMs: 250,
    waitUntil: promise => { lifetime = promise; promise.then(() => { settled = true; }); },
  });
  await f.client.ready;
  assert.equal(settled, false);
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.received.length === 1);
  await lifetime;
  await waitFor(() => f.states.filter(state => state === 'connected').length === 2);
  assert.deepEqual(f.errors, []);
  assert.ok(f.upstreams.slice(0, 2).every(socket => socket.readyState === WebSocket.CLOSED));
  assert.ok(f.billing.at(-1).p_close);
  assert.ok(f.billing.at(-1).p_seconds <= 1);
  f.client.send({ type: 'audio', direction: 'incoming', data: 'AAAAAA==' });
  await waitFor(() => f.upstreams[3].messages.some(message => message.realtimeInput));
});

test('Gemini goAway reconnects without a fatal error and settles the old session first', async t => {
  const f = await fixture(t); await f.client.ready;
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.received.length === 1);
  f.upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: { timeLeft: '1s' } })));
  await waitFor(() => f.states.filter(state => state === 'connected').length === 2);
  assert.deepEqual(f.errors, []);
  assert.ok(f.billing.at(-1).p_close);
  assert.ok(!f.received.some(message => message.type === 'clear')); // Planned handoff keeps playback open.
});

test('audio continues under existing credit authorization while a renewal is slow', async t => {
  let calls = 0, releaseRenewal;
  const f = await fixture(t, { rpc: async (_name, args) => {
    if (!args.p_close && ++calls === 2) await new Promise(resolve => { releaseRenewal = resolve; });
    return { data: { authorizedSeconds: args.p_seconds } };
  } }, { renewalMs: 50 });
  t.after(() => releaseRenewal?.());
  await f.client.ready;
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => releaseRenewal);
  const before = f.received.length;
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.received.length > before);
  assert.equal(calls, 2);
  assert.deepEqual(f.errors, []);
  releaseRenewal();
});

test('planned rotation prepares the replacement and closes the first billing lease before new audio', async t => {
  const calls = [];
  let activeLease;
  const f = await fixture(t, { rpc: async (_name, args) => {
    calls.push(args);
    if (args.p_close) { if (activeLease === args.p_session) activeLease = null; }
    else {
      assert.ok(!activeLease || activeLease === args.p_session, 'Old lease must settle before replacement reserves');
      activeLease = args.p_session;
    }
    return { data: { authorizedSeconds: args.p_seconds } };
  } }, { maxSessionMs: 1200, handoffLeadMs: 1000, drainMs: 50 });
  await f.client.ready;
  const mic = setInterval(() => f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' }), 80);
  t.after(() => clearInterval(mic));
  await waitFor(() => calls.filter(call => !call.p_close).length >= 2);
  const close = calls.findIndex(call => call.p_close);
  const firstNew = calls.findIndex(call => call.p_session !== calls[0].p_session);
  assert.ok(close >= 0 && close < firstNew);
  assert.equal(f.upstreams.length, 4);
  assert.deepEqual(f.errors, []);
  assert.ok(!f.received.some(message => message.type === 'clear'));
});

test('a hung renewal cannot forward audio after cached credit authorization expires', async t => {
  let calls = 0, release;
  const f = await fixture(t, { rpc: async (_name, args) => {
    if (args.p_close) return { data: {} };
    if (++calls === 1) return { data: { authorizedSeconds: 1 } };
    await new Promise(resolve => { release = resolve; });
    return { data: { authorizedSeconds: 5 } };
  } }, { renewalMs: 50 });
  t.after(() => release?.());
  await f.client.ready;
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.upstreams[0].readyState === WebSocket.CLOSED);
  const count = f.upstreams[0].messages.length;
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.upstreams[0].messages.length, count);
  release();
});

test('rejected authentication does not open Gemini sessions', async t => {
  const f = await fixture(t, { auth: { getUser: async () => ({ error: true }) } });
  await assert.rejects(f.client.ready, /sign-in/);
  assert.equal(f.upstreams.length, 0);
});

test('translation cannot send sign-in tokens over insecure remote connections', () => {
  assert.throws(() => connectTranslation({ gatewayUrl: 'ws://example.com/live' }), /secure/);
});

test('routing requires independent cables and physical headphones; English is fixed', () => {
  assert.equal(validateTranslationOptions({ enabled: true, sourceLanguage: 'fr', targetLanguage: 'es' }).sourceLanguage, 'en');
  assert.throws(() => validateTranslationOptions({ enabled: true, targetLanguage: 'unsupported' }), /supported/);
  const devices = { inputs: [{ id: 1, name: 'Physical Mic' }, { id: 2, name: 'CABLE Output' }, { id: 3, name: 'CABLE-B Output' }], outputs: [{ id: 4, name: 'CABLE Input' }, { id: 5, name: 'Headphones' }] };
  assert.throws(() => validateTranslationRouting({ incoming: true, incomingDevice: 2, headphonesDevice: 5 }, devices, 1, 4), /different virtual cables/);
  validateTranslationRouting({ incoming: true, incomingDevice: 3, headphonesDevice: 5 }, devices, 1, 4);
  assert.throws(() => validateTranslationRouting({ incoming: true, incomingDevice: 3, headphonesDevice: 4 }, devices, 1, 4), /physical headphones/);
});
