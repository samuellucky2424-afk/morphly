import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectTranslation } from '../server/translation-client.js';

const waitFor = async predicate => {
  const until = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > until) assert.fail('Timed out waiting for reconnect');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function fixture(t, handler, options = {}) {
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  let count = 0;
  const sockets = [], frames = [], errors = [], states = [];
  server.on('connection', socket => {
    const connection = ++count; sockets.push(socket);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'auth') handler(socket, connection);
      if (message.type === 'audio') frames.push({ connection, ...message });
    });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const client = connectTranslation({ gatewayUrl: `ws://127.0.0.1:${http.address().port}`, accessToken: 'test', targetLanguage: 'es',
    onAudio() {}, onError: message => errors.push(message), onState: state => states.push(state), retryBaseMs: 10, retryWindowMs: 250, ...options });
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate(); server.close(); await new Promise(resolve => http.close(resolve)); });
  return { client, sockets, frames, errors, states };
}

test('unexpected disconnect reconnects and replays bounded audio captured during the gap', async t => {
  const f = await fixture(t, (socket, count) => {
    if (count === 1) socket.send('{"type":"ready"}');
  });
  await f.client.ready;
  f.sockets[0].terminate();
  await waitFor(() => f.states.includes('reconnecting'));
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.sockets.length === 2);
  f.sockets[1].send('{"type":"ready"}');
  await waitFor(() => f.states.filter(state => state === 'connected').length === 2);
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AQABAA==' });
  await waitFor(() => f.frames.length === 2);
  assert.deepEqual(f.frames.map(frame => frame.data), ['AAAAAA==', 'AQABAA==']);
  assert.ok(f.frames.every(frame => frame.connection === 2));
  assert.deepEqual(f.errors, []);
});

test('a closing account lease retries automatically before ready', async t => {
  const f = await fixture(t, (socket, count) => socket.send(JSON.stringify(count < 3
    ? { type: 'error', retryable: true, message: 'Previous session closing' } : { type: 'ready' })));
  await f.client.ready;
  assert.equal(f.sockets.length, 3);
  assert.deepEqual(f.errors, []);
});

test('Stop during reconnect cancels all pending retries', async t => {
  const f = await fixture(t, socket => socket.send('{"type":"ready"}'), { retryBaseMs: 80 });
  await f.client.ready;
  f.sockets[0].terminate();
  await waitFor(() => f.states.includes('reconnecting'));
  f.client.close();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.errors, []);
});

test('authentication or credit errors stop immediately instead of reconnecting', async t => {
  const f = await fixture(t, socket => socket.send('{"type":"error","message":"Not enough credits"}'));
  await assert.rejects(f.client.ready, /Not enough credits/);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.errors.length, 1);
});

test('persistent failures end after a bounded retry window', async t => {
  const f = await fixture(t, socket => socket.terminate(), { retryWindowMs: 120 });
  await assert.rejects(f.client.ready, /could not reconnect/);
  assert.equal(f.errors.length, 1);
});

test('Stop before the first WebSocket connection cannot leave a remote session running', async t => {
  const f = await fixture(t, socket => socket.send('{"type":"ready"}'));
  const failed = assert.rejects(f.client.ready, /stopped/);
  f.client.close();
  await failed;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.sockets.length, 0);
  assert.deepEqual(f.errors, []);
});

test('replacement prepares while old audio flows, then drains and activates without tearing down playback', async t => {
  const controls = [];
  const f = await fixture(t, (socket, count) => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); controls.push({ connection: count, type: message.type });
      if (message.type === 'drain') socket.send('{"type":"stopped"}');
      if (message.type === 'activate') socket.send('{"type":"ready"}');
    });
    if (count === 1) socket.send('{"type":"ready"}');
  });
  await f.client.ready;
  f.sockets[0].send('{"type":"rotate","handoffToken":"fixture"}');
  await waitFor(() => f.sockets.length === 2);
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.frames.length === 1);
  assert.equal(f.frames[0].connection, 1);
  assert.equal(controls.some(message => message.type === 'drain'), false);
  f.sockets[1].send('{"type":"prepared"}');
  await waitFor(() => controls.some(message => message.type === 'activate'));
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AQABAA==' });
  await waitFor(() => f.frames.length === 2);
  assert.equal(f.frames[1].connection, 2);
  assert.ok(controls.findIndex(message => message.type === 'drain') < controls.findIndex(message => message.type === 'activate'));
  assert.deepEqual(f.errors, []);
});

test('failed standby preparation leaves the original audio path running', async t => {
  const f = await fixture(t, (socket, count) => {
    if (count === 1) socket.send('{"type":"ready"}'); else socket.terminate();
  });
  await f.client.ready;
  f.sockets[0].send('{"type":"rotate","handoffToken":"fixture"}');
  await waitFor(() => f.sockets.length === 2);
  await new Promise(resolve => setTimeout(resolve, 30));
  f.client.send({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  await waitFor(() => f.frames.length === 1);
  assert.equal(f.frames[0].connection, 1);
  assert.deepEqual(f.errors, []);
});

test('Stop during standby preparation closes both sockets and never activates the replacement', async t => {
  const f = await fixture(t, (socket, count) => { if (count === 1) socket.send('{"type":"ready"}'); });
  await f.client.ready;
  f.sockets[0].send('{"type":"rotate","handoffToken":"fixture"}');
  await waitFor(() => f.sockets.length === 2);
  f.client.close();
  await waitFor(() => f.sockets.every(socket => socket.readyState === 3));
  assert.deepEqual(f.errors, []);
});
