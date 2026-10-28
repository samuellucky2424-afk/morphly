import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { issueViduDemoTicket, validateViduDemoTicket } from '../server/vidu-demo-ticket.js';
import { claimViduDemoLease, releaseViduDemoLease, initializeViduDemoLease, createViduDemoProxyServer } from '../server/vidu-demo-proxy.js';

const origin = 'https://preview.example', audience = 'immutable-preview.vercel.app';
const secret = randomBytes(32).toString('base64url');
const environment = { VERCEL_ENV: 'preview', VIDU_DEMO_PROXY: 'true', VIDU_API_BASE_URL: 'https://api.vidu.com', VERCEL_URL: audience };
const waitFor = async predicate => {
  const until = Date.now() + 4000;
  while (!predicate()) { if (Date.now() >= until) assert.fail('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

// Transactions are serialized like Firestore; notifications happen only after
// commit. This catches claim races without any account or external service.
function store() {
  const rows = new Map([
    ['sessions/session', { user_id: 'owner', status: 'active', provider: 'vidu', billing_version: 2, provider_max_seconds: 120, seconds_used: 0 }],
    ['users/owner', { account_status: 'active' }], ['wallets/wallet', { user_id: 'owner', credits: 1000 }],
  ]);
  const watchers = new Map(); let pending = Promise.resolve();
  const snapshot = ref => ({ ref, id: ref.id, exists: rows.has(ref.path), data: () => rows.has(ref.path) ? { ...rows.get(ref.path) } : undefined });
  const ref = path => ({ path, id: path.split('/')[1],
    onSnapshot(fn) {
      const callbacks = watchers.get(path) || new Set(); callbacks.add(fn); watchers.set(path, callbacks);
      queueMicrotask(() => { if (callbacks.has(fn)) fn(snapshot(ref(path))); });
      return () => callbacks.delete(fn);
    },
  });
  const notify = path => queueMicrotask(() => { for (const fn of watchers.get(path) || []) fn(snapshot(ref(path))); });
  const db = {
    collection: name => ({ doc: id => ref(`${name}/${id}`), where: (field, _operator, value) => ({ name, field, value }) }),
    runTransaction(fn) {
      const result = pending.then(async () => {
        const writes = [];
        const value = await fn({
          get: async target => target.path ? snapshot(target) : (() => {
            const docs = [...rows].filter(([path, row]) => path.startsWith(`${target.name}/`) && row[target.field] === target.value).map(([path]) => snapshot(ref(path)));
            return { size: docs.length, docs };
          })(),
          update: (target, change) => writes.push([target.path, change]),
        });
        for (const [path, change] of writes) { rows.set(path, { ...rows.get(path), ...change }); notify(path); }
        return value;
      });
      pending = result.catch(() => {}); return result;
    },
    update(path, change) { rows.set(path, { ...rows.get(path), ...change }); notify(path); },
    row: path => rows.get(path), watchers,
  };
  return db;
}

function ticket(overrides = {}) {
  return issueViduDemoTicket({ secret, userId: 'owner', sessionId: 'session', liveId: 'live', clientSecret: 'scoped-secret',
    origin, audience, maxSeconds: 120, providerExpiresAt: Date.now() + 3600000, ...overrides });
}
function payload(issued) { return validateViduDemoTicket(issued.ticket, { secret, audience, origin }); }

test('native session lease admits one concurrent connection and at most three pre-init claims', async () => {
  const db = store(), p = payload(ticket());
  const claims = await Promise.allSettled([claimViduDemoLease(db, p), claimViduDemoLease(db, p)]);
  assert.equal(claims.filter(c => c.status === 'fulfilled').length, 1);
  const first = claims.find(c => c.status === 'fulfilled').value;
  await releaseViduDemoLease(db, first);
  const second = await claimViduDemoLease(db, p); await releaseViduDemoLease(db, first);
  assert.equal(db.row('sessions/session').vidu_demo_lease_id, second.leaseId, 'A stale release cannot clear the new lease');
  await releaseViduDemoLease(db, second);
  const third = await claimViduDemoLease(db, p); await releaseViduDemoLease(db, third);
  await assert.rejects(claimViduDemoLease(db, p), /TICKET_ALREADY_USED/);
  assert.equal(db.row('sessions/session').status, 'active');
  assert.equal(db.row('sessions/session').seconds_used, 0);
});

test('initialized tickets can never be reacquired and authorization checks owner, account, provider, wallet and expiry', async () => {
  const db = store(), p = payload(ticket());
  const lease = await claimViduDemoLease(db, p);
  await initializeViduDemoLease(db, lease, p.userId); await releaseViduDemoLease(db, lease);
  await assert.rejects(claimViduDemoLease(db, p), /TICKET_ALREADY_USED/);
  for (const [path, change] of [['sessions/session', { user_id: 'other' }], ['sessions/session', { status: 'ended' }],
    ['sessions/session', { provider: 'decart' }], ['sessions/session', { billing_version: 1 }],
    ['users/owner', { account_status: 'suspended' }], ['wallets/wallet', { credits: -1 }]]) {
    const unavailable = store(); unavailable.update(path, change);
    await assert.rejects(claimViduDemoLease(unavailable, p), /SESSION_UNAVAILABLE|INSUFFICIENT_CREDITS/);
  }
  await assert.rejects(claimViduDemoLease(store(), p, { now: p.expiresAt }), /EXPIRED_TICKET/);
});

async function fixture(t, options = {}) {
  const db = store(), calls = [], received = [], upstreams = [], lifetimes = [], diagnostics = [];
  const local = createServer(), remote = new WebSocketServer({ server: local });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  remote.on('connection', (socket, req) => {
    upstreams.push({ socket, req });
    socket.on('message', (data, isBinary) => {
      received.push({ data: Buffer.from(data), isBinary });
      if (!isBinary) {
        const value = JSON.parse(data.toString());
        if (value.type === 1 && options.ack !== false) socket.send(JSON.stringify({ type: 2, payload: { conn_init_ack: { success: true } } }));
      }
    });
  });
  const server = createViduDemoProxyServer({ supabase: { db }, secret, apiKey: 'test-server-key', environment, audience,
    logger: { info: (_label, metadata) => diagnostics.push(metadata) },
    waitUntil: promise => lifetimes.push(promise),
    createUpstream: (url, settings) => {
      calls.push({ url, settings });
      const socket = new WebSocket(`ws://127.0.0.1:${local.address().port}`, settings);
      if (options.bufferedAmount) Object.defineProperty(socket, 'bufferedAmount', { get: () => options.bufferedAmount });
      return socket;
    },
    ...options.proxy,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const issued = ticket(options.ticket);
  const url = `ws://127.0.0.1:${server.address().port}/api/vidu/live`;
  const clients = [];
  const connect = (protocols = ['morphly.plus', `morphly-ticket.${issued.ticket}`], settings = {}) => {
    const client = new WebSocket(url, protocols, { headers: { Origin: origin, 'User-Agent': 'Morphly Test Browser' }, ...settings });
    client.on('error', () => {}); clients.push(client); return client;
  };
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const client of server.viduDemoSockets.clients) client.terminate();
    for (const client of remote.clients) client.terminate();
    await Promise.allSettled(lifetimes);
    server.viduDemoSockets.close(); remote.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => local.close(resolve))]);
  });
  return { db, calls, received, upstreams, issued, url, connect, server, lifetimes, diagnostics,
    message: (type, seq_id, extra = {}) => JSON.stringify({ type, seq_id, live_id: 'live', conn_id: issued.connectionId, payload: {}, ...extra }) };
}

test('local signaling forwards exact text/binary frames and private Authorization to only the fixed global path', async t => {
  const f = await fixture(t), client = f.connect(), responses = [];
  client.on('message', (data, isBinary) => responses.push({ data: Buffer.from(data), isBinary }));
  await once(client, 'open'); assert.equal(client.protocol, 'morphly.plus');
  const init = f.message(1, 1, { payload: { conn_init: { version: 1 } } }); client.send(init);
  client.send(Buffer.from([0, 255, 1, 5]));
  await waitFor(() => f.received.length === 2 && responses.length === 1);
  const url = new URL(f.calls[0].url);
  assert.equal(url.origin, 'wss://api.vidu.com'); assert.equal(url.pathname, '/live/ws/live/connect');
  assert.deepEqual(Object.fromEntries(url.searchParams), { live_id: 'live', conn_id: f.issued.connectionId, client_secret: 'scoped-secret' });
  assert.equal(f.upstreams[0].req.headers.authorization, 'Token test-server-key');
  assert.equal(f.upstreams[0].req.headers.origin, origin);
  assert.equal(f.upstreams[0].req.headers['user-agent'], 'Morphly Test Browser');
  assert.equal(f.calls[0].settings.followRedirects, false);
  assert.equal(f.received[0].data.toString(), init); assert.equal(f.received[0].isBinary, false);
  assert.deepEqual(f.received[1], { data: Buffer.from([0, 255, 1, 5]), isBinary: true });
  f.upstreams[0].socket.send('provider-text'); f.upstreams[0].socket.send(Buffer.from([9, 0, 8]));
  await waitFor(() => responses.length === 3);
  assert.equal(responses[1].data.toString(), 'provider-text'); assert.equal(responses[1].isBinary, false);
  assert.deepEqual(responses[2], { data: Buffer.from([9, 0, 8]), isBinary: true });
  const hangup = f.message(5, 2, { payload: { hangup: { hangup_reason: 'user_hangup' } } });
  client.send(hangup); await once(client, 'close');
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.equal(f.received.filter(frame => !frame.isBinary && JSON.parse(frame.data).type === 5).length, 1);
  assert.equal(f.received.at(-1).data.toString(), hangup);
  assert.equal(f.db.row('sessions/session').status, 'active');
  assert.equal(f.db.row('sessions/session').seconds_used, 0, 'Socket teardown cannot bill or discard the client final flush');
  assert.deepEqual(f.diagnostics.map(entry => entry.event), ['upstream_connecting', 'upstream_open', 'initialized', 'closed']);
  assert.equal(f.diagnostics.at(-1).reason, 'CLIENT_HANGUP');
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /test-server-key|scoped-secret|morphly-ticket|immutable-preview|https:\/\/preview|session\/session/);
  assert.ok([...f.db.watchers.values()].every(callbacks => callbacks.size === 0));
});

test('abrupt browser loss sends one hangup with the next sequence and releases the lease without closing billing', async t => {
  const f = await fixture(t), client = f.connect(); await once(client, 'open');
  client.send(f.message(1, 7)); await waitFor(() => f.db.row('sessions/session').vidu_demo_initialized);
  client.terminate(); await waitFor(() => f.received.some(frame => JSON.parse(frame.data).type === 5));
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  const hangups = f.received.map(frame => JSON.parse(frame.data)).filter(value => value.type === 5);
  assert.equal(hangups.length, 1); assert.equal(hangups[0].seq_id, 8);
  assert.equal(f.db.row('sessions/session').status, 'active');
});

test('an explicitly issued Electron opaque origin is matched exactly and forwarded upstream', async t => {
  const f = await fixture(t, { ticket: { origin: 'null' } });
  const client = f.connect(undefined, { headers: { Origin: 'null' } }); await once(client, 'open');
  client.send(f.message(1, 1)); await waitFor(() => f.db.row('sessions/session').vidu_demo_initialized);
  assert.equal(f.upstreams[0].req.headers.origin, 'null');
  client.close(); await once(client, 'close');
});

test('invalid ownership envelopes terminate before forwarding them; startup timeout also sends hangup', async t => {
  const f = await fixture(t, { ack: false, proxy: { startupMs: 150 } }), client = f.connect(); await once(client, 'open');
  await waitFor(() => f.upstreams.length === 1);
  client.send(f.message(13, 1, { live_id: 'another-live' })); await once(client, 'close');
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.ok(!f.received.some(frame => JSON.parse(frame.data).type === 13));
  const retry = f.connect(); await once(retry, 'open'); await once(retry, 'close');
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 2);
});

test('JSON null is rejected safely without crashing other signaling sessions', async t => {
  const f = await fixture(t), client = f.connect(); await once(client, 'open');
  await waitFor(() => f.upstreams.length === 1);
  client.send('null'); const [code] = await once(client, 'close');
  assert.equal(code, 1008);
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 1);
});

test('full upstream buffering still permits exactly one terminal hangup within the drain deadline', async t => {
  const f = await fixture(t, { bufferedAmount: 8 * 1024 * 1024 + 1 }), client = f.connect(); await once(client, 'open');
  await waitFor(() => f.upstreams.length === 1);
  client.send(f.message(1, 1)); await once(client, 'close');
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.deepEqual(f.received.map(frame => JSON.parse(frame.data).type), [5]);
});

test('session/account/wallet watches stop active signaling while preserving client billing finalization', async t => {
  for (const [path, change] of [['sessions/session', { status: 'ended' }], ['users/owner', { account_status: 'suspended' }], ['wallets/wallet', { credits: 0 }]]) {
    await t.test(path, async t => {
      const f = await fixture(t), client = f.connect(); await once(client, 'open');
      client.send(f.message(1, 1)); await waitFor(() => f.db.row('sessions/session').vidu_demo_initialized);
      f.db.update(path, change); await once(client, 'close');
      await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
      assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 1);
    });
  }
});

test('active duration is enforced by the server and initialization cannot be replayed afterwards', async t => {
  const f = await fixture(t, { ticket: { maxSeconds: 1 }, proxy: { startupMs: 150 } }), client = f.connect(); await once(client, 'open');
  client.send(f.message(1, 1)); await once(client, 'close');
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 1);
  assert.equal(f.db.row('sessions/session').status, 'active');
  const replay = f.connect();
  const status = await new Promise(resolve => replay.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(status, 403); assert.equal(f.calls.length, 1);
});

test('provider expiry bounds the connection independently of the client and active duration', async t => {
  const f = await fixture(t, { ticket: { providerExpiresAt: Date.now() + 500 } }), client = f.connect(); await once(client, 'open');
  client.send(f.message(1, 1)); await once(client, 'close');
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 1);
});

test('oversized client frames cannot reach the provider, and teardown remains bounded', async t => {
  const f = await fixture(t), client = f.connect(); await once(client, 'open');
  await waitFor(() => f.upstreams.length === 1);
  client.send(Buffer.alloc(4 * 1024 * 1024 + 1)); await once(client, 'close');
  await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.ok(f.received.every(frame => !frame.isBinary));
  assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 1);
});

test('rate limit bounds outbound signaling without changing forwarded frames', async t => {
  const fixedNow = Date.now();
  const f = await fixture(t, { proxy: { now: () => fixedNow } }), client = f.connect(); await once(client, 'open');
  await waitFor(() => f.upstreams.length === 1);
  for (let sequence = 1; sequence <= 61; sequence++) client.send(f.message(1, sequence));
  await once(client, 'close'); await waitFor(() => !f.db.row('sessions/session').vidu_demo_lease_id);
  assert.ok(f.received.filter(frame => JSON.parse(frame.data).type === 1).length <= 60);
  assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 1);
});

test('a stalled lease release cannot keep the browser or function lifetime open after bounded cleanup', async t => {
  const f = await fixture(t, { proxy: { cleanupMs: 25 } }), client = f.connect(); await once(client, 'open');
  client.send(f.message(1, 1)); await waitFor(() => f.db.row('sessions/session').vidu_demo_initialized);
  const transaction = f.db.runTransaction;
  let release;
  f.db.runTransaction = async fn => { await new Promise(resolve => { release = resolve; }); return transaction(fn); };
  t.after(() => release?.());
  let lifetimeEnded = false;
  f.lifetimes.at(-1).then(() => { lifetimeEnded = true; });
  client.terminate(); await waitFor(() => release);
  await waitFor(() => f.server.viduDemoSockets.clients.size === 0);
  await waitFor(() => lifetimeEnded);
  assert.equal(f.received.filter(frame => JSON.parse(frame.data).type === 5).length, 1);
  release();
});

test('production relay accepts an authorized deployment-bound ticket with the explicit global opt-in', async t => {
  const f = await fixture(t, { proxy: { environment: { ...environment, VERCEL_ENV: 'production' } } });
  const client = f.connect();
  await once(client, 'open');
  client.send(f.message(1, 1, { payload: { conn_init: { version: 1 } } }));
  await waitFor(() => f.received.length === 1);
  assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.calls[0].url).origin, 'wss://api.vidu.com');
  assert.equal(f.upstreams[0].req.headers.origin, origin);
  client.send(f.message(5, 2, { payload: { hangup: { hangup_reason: 'user_hangup' } } }));
  await once(client, 'close');
});

test('upgrade gate rejects disabled deployments, malformed ticket, wrong origin, and missing configuration before upstream access', async t => {
  for (const proxy of [{ environment: { ...environment, VERCEL_ENV: 'development' } }, { secret: '' }, {}]) {
    await t.test(JSON.stringify(Object.keys(proxy)), async t => {
      const f = await fixture(t, { proxy });
      const protocols = Object.keys(proxy).length ? undefined : ['morphly.plus', 'morphly-ticket.invalid'];
      const client = f.connect(protocols);
      const status = await new Promise(resolve => client.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }));
      assert.equal(status, proxy.environment ? 404 : proxy.secret === '' ? 503 : 403);
      assert.equal(f.calls.length, 0);
    });
  }
  const f = await fixture(t), client = f.connect(undefined, { headers: { Origin: 'https://attacker.example' } });
  const status = await new Promise(resolve => client.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(status, 403); assert.equal(f.calls.length, 0);
});
