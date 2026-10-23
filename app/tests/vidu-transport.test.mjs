import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/vidu-realtime.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const apiSource = readFileSync(new URL('../src/lib/api-client.ts', import.meta.url), 'utf8');
const compiledApi = ts.transpileModule(apiSource.replace(/import\.meta\.env/g, 'testEnvironment'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(userAgent = '', supportCheck = async () => ({ support: true }), pageUrl = 'https://preview.morphly.test', { electron = false, environment = {} } = {}) {
  const events = new Map();
  const timers = new Map();
  const sent = [];
  const diagnostics = [];
  let socket;
  let destroyed = 0;
  let supportChecks = 0;
  let now = Date.now();
  class ClockDate extends Date { static now() { return now; } }
  const original = { readyState: 'live', stopped: false, stop() { this.stopped = true; }, clone: () => clone };
  const clone = { readyState: 'live', stopped: false, stop() { this.stopped = true; } };
  const generated = { kind: 'video', id: 'generated', readyState: 'live' };
  let selected;
  let audio;
  const engine = {
    on: (name, fn) => events.set(name, fn),
    removeAllListeners: () => events.clear(),
    publishLocalAudioStream: async value => { audio = value; },
    setDefaultSubscribeAllRemoteAudioStreams: value => assert.equal(value, false),
    setDefaultSubscribeAllRemoteVideoStreams: value => assert.equal(value, false),
    switchCamera: async (_id, track) => { selected = track; },
    getVideoTrack: async ({ userId, streamType }) => { assert.equal(streamType, 0); return userId ? generated : selected; },
    joinChannel: async (token, uid) => { assert.equal(token, 'rtc-token'); assert.equal(uid, 'camera-user'); },
    startPreview: async () => {},
    publishLocalVideoStream: async enabled => {
      assert.equal(enabled, true);
      events.get('videoPublishStateChanged')?.(1, 2);
      events.get('videoPublishStateChanged')?.(2, 3);
    },
    destroy: async () => { destroyed++; },
  };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    constructor(url, protocols) { this.url = url; this.protocols = Array.from(protocols || []); socket = this; }
    send(json) { sent.push(JSON.parse(json)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const exports = {};
  const pageWindow = { location: new URL(pageUrl), addEventListener() {}, removeEventListener() {}, ...(electron ? { electron: {} } : {}) };
  const apiExports = {};
  vm.runInContext(compiledApi, vm.createContext({ exports: apiExports, window: pageWindow, URL,
    testEnvironment: environment, require: () => ({ firebaseSessionClient: {} }),
  }));
  const context = vm.createContext({
    navigator: { userAgent }, exports, URL, URLSearchParams, Date: ClockDate, crypto: { randomUUID: () => 'connection-id' }, WebSocket: Socket,
    console: { warn: (_label, message) => diagnostics.push(JSON.parse(message)),
      info: (_label, message) => diagnostics.push(JSON.parse(message)) },
    window: pageWindow,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getVideoTracks() { return this.tracks; } },
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => name === './api-client' ? apiExports : name === './realtime-provider' ? { VIDU_REALTIME_MODEL: 's2-editing' } : {
      default: { isSupported: async () => { supportChecks++; return supportCheck(); }, AliRtcLogLevel: { NONE: 5 },
        setLogLevel(level) { assert.equal(level, 5, 'raw SDK credential logs must be disabled'); }, getInstance: () => engine },
    },
  });
  vm.runInContext(compiled, context);
  const outputs = [];
  const errors = [];
  const client = exports.createViduClient({ apiKey: 'short-lived-secret' });
  const options = { liveId: 'live-id', traceId: 'trace-id', renderUid: 'renderer', rtc: { token: 'rtc-token', user_id: 'camera-user' }, maxSeconds: 60,
    onRemoteStream: stream => outputs.push(stream), onError: error => errors.push(error) };
  return { exports, client, options, input: { getVideoTracks: () => [original] }, original, clone, generated, outputs, errors,
    events, timers, sent, engine, diagnostics, advanceTime(ms) { now += ms; }, get now() { return now; }, get socket() { return socket; }, get destroyed() { return destroyed; }, get audio() { return audio; }, get supportChecks() { return supportChecks; } };
}

test('Vidu connects to the session regional host without changing its credential pair', async () => {
  for (const baseUrl of ['https://api.vidu.com', 'https://api.vidu.cn']) {
    const h = harness();
    const connected = h.client.connect(h.input, { ...h.options, baseUrl });
    const rejection = assert.rejects(connected, /ended this session/);
    await tick();
    const url = new URL(h.socket.url);
    assert.equal(url.hostname, new URL(baseUrl).hostname);
    assert.equal(url.searchParams.get('live_id'), h.options.liveId);
    assert.equal(url.searchParams.get('client_secret'), 'short-lived-secret');
    h.socket.open();
    h.socket.message({ type: 6, payload: { hangup: { hangup_reason: 'user_hangup' } } });
    await rejection;
    assert.equal(h.timers.size, 0);
  }
});

test('Vidu rejects expired credentials before loading RTC or opening a socket', async () => {
  const h = harness();
  await assert.rejects(h.client.connect(h.input, { ...h.options,
    rtc: { ...h.options.rtc, token_expire_at: String(Math.floor(h.now / 1000) - 1) } }), /credentials expired/);
  assert.equal(h.supportChecks, 0);
  assert.equal(h.socket, undefined);
  assert.equal(h.timers.size, 0);
});

test('Vidu uses server time and cannot retry a handshake after credentials expire', async () => {
  const h = harness();
  // A browser clock ahead by a day must not invalidate fresh provider credentials.
  const serverNow = h.now - 86400000;
  const expiresAt = new Date(serverNow + 2000).toISOString();
  const connected = h.client.connect(h.input, { ...h.options, serverNow, expiresAt });
  const rejection = assert.rejects(connected, /credentials expired/);
  await tick();
  const first = h.socket;
  first.onerror();
  h.advanceTime(2001);
  [...h.timers.values()].find(timer => timer.ms === 1000).fn();
  await rejection;
  assert.equal(h.socket, first);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
});

test('Vidu closes an initialized session at the provider credential deadline', async () => {
  const h = harness();
  const connected = h.client.connect(h.input, { ...h.options, expiresAt: new Date(h.now + 10000).toISOString() });
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  const session = await connected;
  h.advanceTime(10000);
  [...h.timers.values()].find(timer => timer.ms === 10000).fn();
  await tick();
  assert.equal(session.getConnectionState(), 'disconnected');
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
});

test('Plus preflight checks and caches RTC readiness without opening a session or camera', async () => {
  const h = harness();
  const first = h.exports.prepareViduRtc();
  assert.equal(h.exports.prepareViduRtc(), first);
  await first;
  assert.equal(h.supportChecks, 1);
  assert.equal(h.socket, undefined);
  assert.equal(h.events.size, 0);
  assert.equal(h.original.stopped, false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.client.connect(h.input, { ...h.options, signal: controller.signal }), /cancelled/);
  assert.equal(h.supportChecks, 1);
  assert.equal(h.socket, undefined);
});

test('unsupported RTC preflight can be retried without creating provider connections', async () => {
  let supported = false;
  const h = harness('', async () => ({ support: supported }));
  await assert.rejects(h.exports.prepareViduRtc(), /cannot run Plus/);
  supported = true;
  await h.exports.prepareViduRtc();
  assert.equal(h.supportChecks, 2);
  assert.equal(h.socket, undefined);
});

test('Vidu uses scoped signaling credentials and displays only the renderer, then hangs up once', async () => {
  const h = harness();
  const connected = h.client.connect(h.input, h.options);
  await tick();
  const url = new URL(h.socket.url);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('client_secret'), 'short-lived-secret');
  assert.equal(url.searchParams.has('api_key'), false);
  assert.equal(h.audio, false);
  h.socket.open();
  assert.equal(h.sent[0].type, 1);
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  h.events.get('videoSubscribeStateChanged')('someone-else', 2, 3);
  await tick();
  assert.equal(h.outputs.length, 0);
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  const session = await connected;
  assert.equal(h.outputs[0].getVideoTracks()[0], h.generated);
  await session.set({ image: 'https://example.com/new.png', editingType: 'background_replacement', prompt: 'This text must not reach the provider' });
  assert.equal(h.sent[1].type, 13);
  assert.equal(h.sent[1].payload.switch_prompt.editing_type, 'subject_replacement');
  assert.equal(h.sent[1].live_id, 'live-id');
  assert.equal(h.sent[1].conn_id, 'connection-id');
  assert.deepEqual(h.sent[1].payload.switch_prompt.prompts, [{type:'image',content:'https://example.com/new.png'}]);
  await session.disconnect();
  await session.disconnect();
  assert.deepEqual(h.sent.map(message => message.type), [1, 13, 5]);
  assert.deepEqual(h.sent.map(message => message.seq_id), [1, 2, 3]);
  assert.equal(h.clone.stopped, true);
  assert.equal(h.original.stopped, false);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
});

test('Vidu retries NOT_READY initialization and releases camera/RTC after startup timeout', async () => {
  const h = harness();
  const connected = h.client.connect(h.input, h.options);
  const rejection = assert.rejects(connected, /timed out/);
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: false, error_code: 'NOT_READY' } } });
  [...h.timers.values()].find(timer => timer.ms === 2000).fn();
  assert.deepEqual(h.sent.map(message => message.type), [1, 1]);
  [...h.timers.values()].find(timer => timer.ms === 35000).fn();
  await rejection;
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.destroyed, 1);
  assert.equal(h.clone.stopped, true);
});

test('Vidu quality-test deadline hangs up an active session', async () => {
  const h = harness();
  const connected = h.client.connect(h.input, h.options);
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  const session = await connected;
  [...h.timers.values()].find(timer => timer.ms === 60000).fn();
  await tick();
  assert.equal(session.getConnectionState(), 'disconnected');
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.destroyed, 1);
});

test('Vidu rejects master keys, mock credentials and unrelated signaling hosts', async () => {
  const h = harness();
  for (const apiKey of ['vda_master-key', 'mock_preview']) {
    await assert.rejects(h.exports.createViduClient({ apiKey }).connect(h.input, h.options), /real Vidu session credentials/);
  }
  assert.throws(() => h.exports.buildViduSocketUrl('https://example.com', 'live', 'conn', 'secret'), /Unsupported/);
  assert.throws(() => h.exports.buildViduSocketUrl('https://service.vidu.com', 'live', 'conn', 'secret'), /Unsupported/);
  assert.equal(h.socket, undefined);
});

test('Vidu preserves safe provider close reasons with controlled diagnostics only', async () => {
  for (const reason of ['sip_close', 'duration_limit', 'https://secret.test/?token=secret', undefined]) {
    const h = harness();
    const connected = h.client.connect(h.input, h.options);
    const rejection = assert.rejects(connected, reason === 'sip_close' ? /sip_close/ : reason === 'duration_limit' ? /duration_limit/ : /unknown/);
    await tick();
    h.socket.open();
    h.socket.message({ type: 6, payload: { hangup: { hangup_reason: reason } } });
    await rejection;
    assert.equal(h.destroyed, 1);
    assert.equal(h.diagnostics.at(-1).event, 'startup_failed');
    assert.equal(h.diagnostics.at(-1).phase, 'signaling_open');
    const logged = JSON.stringify(h.diagnostics);
    for (const secret of ['short-lived-secret', 'rtc-token', 'secret.test', 'live-id', 'trace-id', 'renderer', 'camera-user']) {
      assert.equal(logged.includes(secret), false);
    }
  }
});

test('cancelling Vidu startup tears down signaling and RTC before a renderer arrives', async () => {
  const h = harness();
  const controller = new AbortController();
  const connected = h.client.connect(h.input, { ...h.options, signal: controller.signal });
  const rejection = assert.rejects(connected, /cancelled/);
  await tick();
  h.socket.open();
  controller.abort();
  await rejection;
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.destroyed, 1);
  assert.equal(h.clone.stopped, true);
  assert.equal(h.original.stopped, false);
});

test('Vidu retries handshake failures on the same session and connection, then succeeds', async () => {
  const h=harness(); const connected=h.client.connect(h.input,h.options);await tick();
  const first=h.socket;const originalUrl=first.url;first.onerror();
  [...h.timers.values()].find(timer=>timer.ms===1000).fn();
  assert.notEqual(h.socket,first);assert.equal(h.socket.url,originalUrl);
  h.socket.open();h.socket.message({type:2,payload:{conn_init_ack:{success:true}}});await tick();
  h.events.get('videoSubscribeStateChanged')('renderer',2,3);
  const session=await connected;assert.equal(h.errors.length,0);await session.disconnect();assert.equal(h.destroyed,1);
});

test('Vidu bounds failed handshakes and tears down all retry timers', async () => {
  const h=harness();const connected=h.client.connect(h.input,h.options);const rejection=assert.rejects(connected,/signaling could not connect/);await tick();
  h.socket.onerror();[...h.timers.values()].find(timer=>timer.ms===1000).fn();
  h.socket.onerror();[...h.timers.values()].find(timer=>timer.ms===2000).fn();
  h.socket.onerror();await rejection;assert.equal(h.destroyed,1);assert.equal(h.timers.size,0);assert.equal(h.sent.length,0);
});

test('cancelling during a Vidu handshake retry cannot open another socket', async () => {
  const h=harness();const controller=new AbortController();const connected=h.client.connect(h.input,{...h.options,signal:controller.signal});const rejection=assert.rejects(connected,/cancelled/);await tick();
  const first=h.socket;first.onerror();const retry=[...h.timers.values()].find(timer=>timer.ms===1000).fn;
  controller.abort();await rejection;retry();assert.equal(h.socket,first);assert.equal(h.timers.size,0);
});


test('signaling failures keep their code without diagnosing browser or network filtering', async () => {
  const h=harness('Mozilla/5.0 Chrome/154 Safari/537.36 Edg/154.0.0.0');
  const connected=h.client.connect(h.input,h.options);const rejection=assert.rejects(connected,/signaling could not connect/);await tick();
  h.socket.onerror();[...h.timers.values()].find(timer=>timer.ms===1000).fn();
  h.socket.onerror();[...h.timers.values()].find(timer=>timer.ms===2000).fn();h.socket.onerror();
  await rejection;assert.equal(h.errors[0].code,'VIDU_SIGNALING_UNREACHABLE');assert.doesNotMatch(h.errors[0].message,/Edge|Chrome|filter|blocking/i);
});

const proxySignaling = { transport: 'proxy', path: '/api/vidu/live', connectionId: 'relay-fixed-connection' };
const relayTicket = 'v1.encrypted-ticket.fixture-signature';
const proxyClient = h => h.exports.createViduClient({ apiKey: relayTicket, signaling: proxySignaling });

test('Plus proxy uses the page origin, server ticket and full server-selected stream duration', async () => {
  const h = harness('', undefined, 'https://preview.morphly.test:8443/#/dashboard');
  const connected = proxyClient(h).connect(h.input, { ...h.options, baseUrl: 'https://untrusted.example', maxSeconds: 1000 });
  await tick();
  assert.equal(h.socket.url, 'wss://preview.morphly.test:8443/api/vidu/live');
  assert.deepEqual(h.socket.protocols, ['morphly.plus', `morphly-ticket.${relayTicket}`]);
  assert.equal(h.socket.url.includes(relayTicket), false);
  assert.equal(new URL(h.socket.url).search, '');
  assert.equal(h.audio, false);
  h.socket.open();
  assert.equal(h.sent[0].type, 1);
  assert.equal(h.sent[0].conn_id, proxySignaling.connectionId);
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  const session = await connected;
  assert.equal(h.outputs[0].getVideoTracks()[0], h.generated);
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 1000000).length, 1, 'active sessions use the server-provided duration');
  await session.set({ image: 'https://example.com/replacement.png' });
  await session.disconnect();
  await session.disconnect();
  assert.deepEqual(h.sent.map(message => message.type), [1, 13, 5]);
  assert.ok(h.sent.every(message => message.conn_id === proxySignaling.connectionId));
  assert.equal(h.clone.stopped, true);
  assert.equal(h.original.stopped, false);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(JSON.stringify(h.diagnostics).includes(relayTicket), false);
});

test('Plus proxy rejects invalid metadata and insecure pages before any transport is opened', async () => {
  const invalid = [null, { ...proxySignaling, transport: 'direct' },
    { ...proxySignaling, path: 'https://untrusted.example/api/vidu/live' },
    { ...proxySignaling, path: '//untrusted.example/api/vidu/live' },
    { ...proxySignaling, path: '/api/vidu/live?ticket=secret' },
    { ...proxySignaling, path: '/api/vidu/other' },
    { ...proxySignaling, connectionId: '' }, { ...proxySignaling, connectionId: 'bad connection' }];
  for (const signaling of invalid) {
    const h = harness();
    await assert.rejects(proxyClient(h).connect(h.input, { ...h.options, signaling }), /Unsupported Plus relay/);
    assert.equal(h.socket, undefined);
    assert.equal(h.supportChecks, 0);
    assert.equal(h.timers.size, 0);
  }
  for (const pageUrl of ['http://preview.morphly.test']) {
    const h = harness('', undefined, pageUrl);
    await assert.rejects(proxyClient(h).connect(h.input, h.options), /Unsupported Plus relay/);
    assert.equal(h.socket, undefined);
    assert.equal(h.supportChecks, 0);
  }
  for (const apiKey of ['ticket/unsafe=', 't'.repeat(12001)]) {
    const h = harness();
    await assert.rejects(h.exports.createViduClient({ apiKey, signaling: proxySignaling }).connect(h.input, h.options), /credentials are invalid/);
    assert.equal(h.socket, undefined);
    assert.equal(h.supportChecks, 0);
  }
});

test('a packaged file renderer resolves its configured Morphly API origin before its preload bridge is ready', async () => {
  const h = harness('', undefined, 'file:///app/index.html', {
    environment: { VITE_API_BASE_URL: 'https://desktop.morphly.test/api' },
  });
  const client = h.exports.createViduClient({ apiKey: relayTicket });
  const controller = new AbortController();
  const connected = client.connect(h.input, {
    ...h.options,
    signaling: { ...proxySignaling, origin: 'https://desktop.morphly.test' },
    signal: controller.signal,
  });
  const rejection = assert.rejects(connected, /cancelled/);
  await tick();
  assert.equal(h.socket.url, 'wss://desktop.morphly.test/api/vidu/live');
  controller.abort();
  await rejection;
});

test('Plus accepts encrypted relay tickets larger than scoped secrets through the shared 12000-character bound', async () => {
  for (const length of [6000, 12000]) {
    const h = harness();
    const apiKey = `v1.${'t'.repeat(length - 3)}`;
    const controller = new AbortController();
    const client = h.exports.createViduClient({ apiKey, signaling: proxySignaling });
    const connected = client.connect(h.input, { ...h.options, signal: controller.signal });
    const rejection = assert.rejects(connected, /cancelled/);
    await tick();
    assert.equal(h.socket.protocols[1], `morphly-ticket.${apiKey}`);
    assert.equal(h.socket.url.includes(apiKey), false);
    controller.abort();
    await rejection;
    assert.equal(h.timers.size, 0);
  }
});

test('Plus proxy retries initialization within its 120s startup window without joining RTC early', async () => {
  const h = harness();
  let joined = false;
  h.engine.joinChannel = async () => { joined = true; };
  const connected = proxyClient(h).connect(h.input, h.options);
  const rejection = assert.rejects(connected, /timed out/);
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: false, error_code: 'NOT_READY' } } });
  [...h.timers.values()].find(timer => timer.ms === 2000).fn();
  assert.deepEqual(h.sent.map(message => message.type), [1, 1]);
  assert.ok(h.sent.every(message => message.conn_id === proxySignaling.connectionId));
  assert.equal(joined, false);
  assert.equal([...h.timers.values()].some(timer => timer.ms === 35000), false);
  [...h.timers.values()].find(timer => timer.ms === 120000).fn();
  await rejection;
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.clone.stopped, true);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
});

test('Plus proxy cancellation clears retries and never falls back to direct signaling', async () => {
  const h = harness();
  const controller = new AbortController();
  const connected = proxyClient(h).connect(h.input, { ...h.options, signal: controller.signal });
  const rejection = assert.rejects(connected, /cancelled/);
  await tick();
  const first = h.socket;
  first.onerror();
  const retry = [...h.timers.values()].find(timer => timer.ms === 1000).fn;
  retry();
  assert.notEqual(h.socket, first);
  assert.equal(h.socket.url, first.url);
  assert.deepEqual(h.socket.protocols, first.protocols);
  h.socket.open();
  controller.abort();
  await rejection;
  const cancelledSocket = h.socket;
  retry();
  assert.equal(h.socket, cancelledSocket);
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.sent.at(-1).conn_id, proxySignaling.connectionId);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.original.stopped, false);
  assert.equal(JSON.stringify(h.diagnostics).includes(relayTicket), false);
});

test('Plus proxy startup remains bounded by provider credentials even with its longer allowance', async () => {
  const h = harness();
  const connected = proxyClient(h).connect(h.input, { ...h.options, expiresAt: new Date(h.now + 10000).toISOString() });
  const rejection = assert.rejects(connected, /credentials expired/);
  await tick();
  h.socket.open();
  h.advanceTime(10000);
  [...h.timers.values()].find(timer => timer.ms === 10000).fn();
  await rejection;
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
});

test('packaged Electron proxies only to its configured HTTPS API origin', async () => {
  for (const [environment, origin] of [
    [{ VITE_API_BASE_URL: 'https://desktop.morphly.test/api' }, 'https://desktop.morphly.test'],
    [{ VITE_API_URL: 'https://other.morphly.test' }, 'https://other.morphly.test'],
    [{ VITE_API_BASE_URL: '/api' }, 'https://morphly-alpha.vercel.app'],
    [{}, 'https://morphly-alpha.vercel.app'],
    [{ VITE_API_BASE_URL: '/api', VITE_PUBLIC_APP_URL: 'https://live.morphly.fun' }, 'https://live.morphly.fun'],
  ]) {
    const h = harness('', undefined, 'file:///app/index.html', { electron: true, environment });
    const client = h.exports.createViduClient({ apiKey: relayTicket });
    const controller = new AbortController();
    const connected = client.connect(h.input, { ...h.options,
      signaling: { ...proxySignaling, origin }, signal: controller.signal });
    const rejection = assert.rejects(connected, /cancelled/);
    await tick();
    assert.equal(h.socket.url, `${origin.replace('https:', 'wss:')}/api/vidu/live`);
    assert.deepEqual(h.socket.protocols, ['morphly.plus', `morphly-ticket.${relayTicket}`]);
    assert.equal(new URL(h.socket.url).search, '');
    controller.abort();
    await rejection;
    assert.equal(h.destroyed, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('Plus rejects supplied origins outside the trusted web or packaged API origin', async () => {
  for (const page of [
    { pageUrl: 'https://preview.morphly.test', electron: false, environment: { VITE_API_BASE_URL: 'https://older.example/api' } },
    { pageUrl: 'file:///app/index.html', electron: true, environment: { VITE_API_BASE_URL: 'https://preview.morphly.test/api' } },
  ]) {
    for (const origin of ['https://untrusted.example', 'https://preview.morphly.test/',
      'http://preview.morphly.test', 'https://preview.morphly.test?ticket=secret']) {
      const h = harness('', undefined, page.pageUrl, page);
      await assert.rejects(proxyClient(h).connect(h.input, { ...h.options, signaling: { ...proxySignaling, origin } }), /Unsupported Plus relay/);
      assert.equal(h.socket, undefined);
      assert.equal(h.supportChecks, 0);
    }
  }
  for (const VITE_API_BASE_URL of ['http://desktop.morphly.test/api', 'https://user:password@desktop.morphly.test/api']) {
    const h = harness('', undefined, 'file:///app/index.html', { electron: true, environment: { VITE_API_BASE_URL } });
    await assert.rejects(proxyClient(h).connect(h.input, h.options), /Unsupported Plus relay/);
    assert.equal(h.socket, undefined);
  }
});

test('Plus handles an SDK publication error even when joinChannel resolves', async () => {
  const h = harness();
  let previewed = false;
  h.engine.startPreview = async () => { previewed = true; };
  h.engine.joinChannel = async () => {
    h.events.get('occurError')({ code: 16843857, message: 'rtc-token short-lived-secret camera-user', token: 'rtc-token' });
  };
  const connected = h.client.connect(h.input, h.options);
  const rejection = assert.rejects(connected, error => {
    assert.match(error.message, /could not publish the camera video/);
    assert.match(error.message, /16843857/);
    assert.equal(error.startupPhase, 'rtc_joining');
    assert.equal(error.rtcCode, 16843857);
    assert.doesNotMatch(error.message, /rtc-token|short-lived-secret|camera-user/);
    return true;
  });
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await rejection;
  assert.equal(previewed, false);
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.clone.stopped, true);
  assert.equal(h.original.stopped, false);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
  for (const forbidden of ['rtc-token', 'short-lived-secret', 'camera-user', 'live-id', 'trace-id']) {
    assert.equal(JSON.stringify(h.diagnostics).includes(forbidden), false);
  }
});

test('Plus joins, previews its selected camera, then waits for confirmed publication', async () => {
  const h = harness();
  const subscriptions = [];
  h.engine.subscribeRemoteMediaStream = (...args) => subscriptions.push(args);
  const order = [];
  h.engine.joinChannel = async () => { order.push('join'); };
  h.engine.startPreview = async () => { order.push('preview'); };
  h.engine.publishLocalVideoStream = async () => { order.push('publish'); };
  let resolved = false;
  const connected = h.client.connect(h.input, h.options).then(session => { resolved = true; return session; });
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  assert.deepEqual(order, ['join', 'preview', 'publish']);
  assert.equal(h.audio, false);
  assert.equal(h.clone.stopped, false);
  assert.equal(h.original.stopped, false);
  h.events.get('remoteUserOnLineNotify')('unrelated-user');
  h.events.get('videoSubscribeStateChanged')('unrelated-user', 2, 3);
  h.events.get('remoteUserOnLineNotify')('renderer');
  assert.deepEqual(subscriptions, [['renderer', 1, true, false]]);
  h.events.get('videoSubscribeStateChanged')('renderer', 1, 2);
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  await tick();
  assert.equal(h.outputs.length, 1);
  assert.equal(resolved, false, 'returning from publish is not publication confirmation');
  assert.equal(h.diagnostics.some(entry => entry.phase === 'published'), false);
  h.events.get('videoPublishStateChanged')(2, 1);
  await tick();
  assert.equal(h.errors.length, 0, 'SDK can internally retry after state 1');
  h.events.get('videoPublishStateChanged')(2, 3);
  const session = await connected;
  assert.ok(h.diagnostics.some(entry => entry.phase === 'published' && entry.code === 3));
  const phases = h.diagnostics.filter(entry => entry.event === 'phase').map(entry => entry.phase);
  assert.deepEqual(phases.slice(0, 7), ['camera_prepared', 'signaling_open', 'initialized',
    'rtc_joining', 'rtc_joined', 'camera_preview', 'publishing']);
  assert.deepEqual(phases.slice(7), ['renderer_online', 'renderer_subscribing', 'renderer_subscribed', 'video_received', 'published']);
  assert.ok(h.diagnostics.every(entry => Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0));
  await session.disconnect();
  assert.equal(h.timers.size, 0);
});

test('Plus scopes subscription failures to its renderer and redacts raw SDK errors', async () => {
  for (const eventName of ['occurError', 'remoteSubscribeError']) {
    const h = harness();
    const connected = proxyClient(h).connect(h.input, h.options);
    const rejection = assert.rejects(connected, error => {
      assert.match(error.message, /could not receive the renderer video/);
      assert.equal(error.rtcCode, 16844114);
      assert.equal(error.startupPhase, 'renderer_subscribing');
      assert.doesNotMatch(error.message, /rtc-token|encrypted-ticket|signature|other-user/);
      return true;
    });
    await tick();
    h.socket.open();
    h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
    await tick();
    const callback = h.events.get(eventName);
    const rawError = { code: 16844114, message: `signed-url?token=rtc-token&ticket=${relayTicket}`, extraInfo: 'other-user' };
    callback(rawError, 'other-user');
    h.events.get('occurError')({ code: 16844113, message: rawError.message }, 'renderer');
    h.events.get('occurError')({ code: 16843856, message: rawError.message });
    h.events.get('occurError')({ code: 'rtc-token', message: rawError.message }, 'renderer');
    await tick();
    assert.equal(h.errors.length, 0, 'other user, audio and nonnumeric errors are not fatal');
    h.events.get('videoSubscribeStateChanged')('renderer', 1, 2);
    callback(rawError, 'renderer');
    await rejection;
    assert.equal(h.sent.at(-1).type, 5);
    assert.equal(h.timers.size, 0);
    const logged = JSON.stringify(h.diagnostics);
    for (const forbidden of ['rtc-token', relayTicket, 'signed-url', 'other-user', 'camera-user', 'live-id', 'trace-id']) {
      assert.equal(logged.includes(forbidden), false);
    }
    for (const entry of h.diagnostics) {
      for (const [key, value] of Object.entries(entry)) {
        if (key !== 'phase' && key !== 'event') assert.equal(typeof value, 'number');
      }
    }
  }
});

test('Plus re-subscribes after early renderer subscription failures instead of ending the session', async () => {
  const h = harness();
  const resubscribed = [];
  h.engine.subscribeRemoteMediaStream = (...args) => resubscribed.push(args);
  const connected = h.client.connect(h.input, h.options);
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  // AliRTC 16844114 (SubscribeVideoStreamFailed) while the renderer is still starting.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    h.events.get('occurError')({ code: 16844114, message: 'rtc-token' }, 'renderer');
    await tick();
    assert.equal(h.errors.length, 0, `failure ${attempt} is retried`);
    const retry = [...h.timers.values()].find(timer => timer.ms === 1000 * attempt);
    assert.ok(retry, `retry ${attempt} is scheduled with backoff`);
    retry.fn();
  }
  assert.deepEqual(resubscribed, [['renderer', 1, true, false], ['renderer', 1, true, false], ['renderer', 1, true, false]]);
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  const session = await connected;
  assert.equal(h.outputs.length, 1);
  await session.disconnect();
  assert.equal(h.timers.size, 0);
});

test('Plus ends the session when renderer subscription keeps failing after retries', async () => {
  const h = harness();
  h.engine.subscribeRemoteMediaStream = () => {};
  const connected = h.client.connect(h.input, h.options);
  const rejection = assert.rejects(connected, error => error.rtcCode === 16844114 && /could not receive the renderer video/.test(error.message));
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  for (let attempt = 0; attempt < 4; attempt += 1) h.events.get('occurError')({ code: 16844114 }, 'renderer');
  await rejection;
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.timers.size, 0);
});

test('Plus still handles fatal startup errors when renderer video arrives before publication confirmation', async () => {
  const h = harness();
  h.engine.publishLocalVideoStream = async () => {};
  const connected = h.client.connect(h.input, h.options);
  const rejection = assert.rejects(connected, /could not publish the camera video/);
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  await tick();
  assert.equal(h.outputs.length, 1);
  h.events.get('occurError')({ code: 16843857, message: 'rtc-token' });
  await rejection;
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.timers.size, 0);
});

test('Plus fails explicitly when the renderer subscription provides no video track', async () => {
  const h = harness();
  const getVideoTrack = h.engine.getVideoTrack;
  h.engine.getVideoTrack = options => options.userId ? Promise.resolve(undefined) : getVideoTrack(options);
  const connected = h.client.connect(h.input, h.options);
  const rejection = assert.rejects(connected, /subscribed to its renderer but received no usable video track/);
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await tick();
  h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
  await rejection;
  assert.equal(h.outputs.length, 0);
  assert.equal(h.destroyed, 1);
  assert.equal(h.timers.size, 0);
});

test('Plus reports camera and terminal RTC startup failures without raw messages', async () => {
  for (const scenario of [
    { event: 'localDeviceException', args: [4, 10, 'rtc-token signed-camera-url'], code: 10, message: /lost access to the selected camera/ },
    { event: 'localDeviceException', args: [6, 13, 'rtc-token signed-camera-url'], code: 13, message: /lost access to the selected camera/ },
    { event: 'connectionStatusChange', args: [5, 6], code: 6, message: /could not connect to its video room/ },
    { event: 'connectionStatusChange', args: [1, 8], code: 8, message: /could not connect to its video room/ },
  ]) {
    const h = harness();
    const connected = h.client.connect(h.input, h.options);
    const rejection = assert.rejects(connected, error => {
      assert.match(error.message, scenario.message);
      assert.equal(error.rtcCode, scenario.code);
      return true;
    });
    await tick();
    h.events.get('localDeviceException')(1, 1, 'rtc-token');
    h.events.get('localDeviceException')(5, 12, 'rtc-token');
    h.events.get('connectionStatusChange')(1, 12);
    h.events.get('connectionStatusChange')(4, 2);
    assert.equal(h.errors.length, 0, 'audio, screen and recoverable RTC states remain nonfatal');
    h.events.get(scenario.event)(...scenario.args);
    await rejection;
    assert.equal(h.timers.size, 0);
    assert.equal(JSON.stringify(h.diagnostics).includes('rtc-token'), false);
  }
});

test('Plus sanitizes rejected RTC operations instead of returning their credential-bearing message', async () => {
  const h = harness();
  h.engine.joinChannel = async () => {
    throw Object.assign(new Error('join rejected: token=rtc-token ticket=short-lived-secret'), { code: 33620485 });
  };
  const connected = h.client.connect(h.input, h.options);
  const rejection = assert.rejects(connected, error => {
    assert.match(error.message, /could not join its video room/);
    assert.equal(error.rtcCode, 33620485);
    assert.doesNotMatch(error.message, /rtc-token|short-lived-secret|join rejected/);
    return true;
  });
  await tick();
  h.socket.open();
  h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
  await rejection;
  assert.equal(h.errors.length, 1);
  assert.equal(h.sent.at(-1).type, 5);
  assert.equal(h.timers.size, 0);
});

test('Plus stops media and signaling immediately and bounds a stalled RTC destroy to two seconds', async () => {
  for (const duringStartup of [true, false]) {
    const h = harness();
    let destroyCalls = 0;
    h.engine.destroy = () => { destroyCalls++; return new Promise(() => {}); };
    const controller = new AbortController();
    const connected = h.client.connect(h.input, { ...h.options, signal: controller.signal });
    const rejection = duringStartup ? assert.rejects(connected, /cancelled/) : null;
    await tick();
    h.socket.open();
    let finished = false;
    let completion;
    if (duringStartup) {
      completion = rejection.then(() => { finished = true; });
      controller.abort();
    } else {
      h.socket.message({ type: 2, payload: { conn_init_ack: { success: true } } });
      await tick();
      h.events.get('videoSubscribeStateChanged')('renderer', 2, 3);
      const session = await connected;
      completion = session.disconnect().then(() => { finished = true; });
    }
    await tick();
    assert.equal(finished, false);
    assert.equal(h.clone.stopped, true);
    assert.equal(h.original.stopped, false);
    assert.equal(h.socket.readyState, 3);
    assert.equal(h.sent.at(-1).type, 5);
    assert.equal(h.events.size, 0);
    assert.equal(destroyCalls, 1);
    assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [2000]);
    [...h.timers.values()][0].fn();
    await completion;
    assert.equal(finished, true);
    assert.equal(h.timers.size, 0);
  }
});
