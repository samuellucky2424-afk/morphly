import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/vidu-realtime.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(userAgent = '') {
  const events = new Map();
  const timers = new Map();
  const sent = [];
  const diagnostics = [];
  let socket;
  let destroyed = 0;
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
    setDefaultSubscribeAllRemoteVideoStreams: value => assert.equal(value, true),
    switchCamera: async (_id, track) => { selected = track; },
    getVideoTrack: async ({ userId, streamType }) => { assert.equal(streamType, 0); return userId ? generated : selected; },
    joinChannel: async (token, uid) => { assert.equal(token, 'rtc-token'); assert.equal(uid, 'camera-user'); },
    publishLocalVideoStream: async enabled => { assert.equal(enabled, true); },
    destroy: async () => { destroyed++; },
  };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    constructor(url) { this.url = url; socket = this; }
    send(json) { sent.push(JSON.parse(json)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const exports = {};
  const context = vm.createContext({
    navigator: { userAgent }, exports, URL, URLSearchParams, crypto: { randomUUID: () => 'connection-id' }, WebSocket: Socket,
    console: { warn: (_label, message) => diagnostics.push(JSON.parse(message)) },
    window: { addEventListener() {}, removeEventListener() {} },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getVideoTracks() { return this.tracks; } },
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => name === './realtime-provider' ? { VIDU_REALTIME_MODEL: 's2-editing' } : {
      default: { isSupported: async () => ({ support: true }), AliRtcLogLevel: { NONE: 5 },
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
    events, timers, sent, engine, diagnostics, get socket() { return socket; }, get destroyed() { return destroyed; }, get audio() { return audio; } };
}

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
  assert.equal(h.socket, undefined);
});

test('Vidu preserves safe provider close reasons and trace IDs without logging credentials', async () => {
  for (const reason of ['sip_close', 'duration_limit', 'https://secret.test/?token=secret', undefined]) {
    const h = harness();
    const connected = h.client.connect(h.input, h.options);
    const rejection = assert.rejects(connected, reason === 'sip_close' ? /sip_close/ : reason === 'duration_limit' ? /duration_limit/ : /unknown/);
    await tick();
    h.socket.open();
    h.socket.message({ type: 6, payload: { hangup: { hangup_reason: reason } } });
    await rejection;
    assert.equal(h.destroyed, 1);
    assert.equal(h.diagnostics[0].traceId, 'trace-id');
    assert.equal(h.diagnostics[0].receivedVideo, false);
    const logged = JSON.stringify(h.diagnostics);
    for (const secret of ['short-lived-secret', 'rtc-token', 'secret.test']) assert.equal(logged.includes(secret), false);
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


test('Edge signaling failures remain browser errors instead of provider-capacity errors', async () => {
  const h=harness('Mozilla/5.0 Chrome/154 Safari/537.36 Edg/154.0.0.0');
  const connected=h.client.connect(h.input,h.options);const rejection=assert.rejects(connected,/could not connect in Edge/);await tick();
  h.socket.onerror();[...h.timers.values()].find(timer=>timer.ms===1000).fn();
  h.socket.onerror();[...h.timers.values()].find(timer=>timer.ms===2000).fn();h.socket.onerror();
  await rejection;assert.equal(h.errors[0].code,'VIDU_SIGNALING_UNREACHABLE');assert.match(h.errors[0].message,/Chrome/);
});
