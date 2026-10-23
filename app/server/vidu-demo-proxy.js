import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { canonicalRelayOrigin, getViduDemoAudience, hasViduDemoProxySecret, isViduDemoProxyEnabled, validateViduDemoTicket } from './vidu-demo-ticket.js';

const PATH = '/api/vidu/live';
const UPSTREAM = 'wss://api.vidu.com/live/ws/live/connect';
const MAX_PAYLOAD = 4 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const CLOSED = 'Plus signaling connection ended.';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function authorized(row, userId) {
  return row?.user_id === userId && row.status === 'active' && row.provider === 'vidu' && row.billing_version === 2;
}

// A durable lease prevents parallel relays across instances. It only records
// signaling state; usage and finalization remain in the existing billing path.
export async function claimViduDemoLease(db, ticket, { now = Date.now(), startupMs = 120000 } = {}) {
  const sessionRef = db.collection('sessions').doc(ticket.sessionId);
  const profileRef = db.collection('users').doc(ticket.userId);
  const leaseId = randomUUID();
  return db.runTransaction(async tx => {
    const [session, profile, wallets] = await Promise.all([
      tx.get(sessionRef), tx.get(profileRef), tx.get(db.collection('wallets').where('user_id', '==', ticket.userId)),
    ]);
    const row = session.data();
    if (!authorized(row, ticket.userId) || profile.data()?.account_status !== 'active') fail('SESSION_UNAVAILABLE');
    if (ticket.expiresAt <= now || ticket.providerExpiresAt <= now) fail('EXPIRED_TICKET');
    if (row.vidu_demo_initialized || row.vidu_demo_lease_id || Number(row.vidu_demo_attempts || 0) >= MAX_ATTEMPTS
      || (row.vidu_demo_connection_id && row.vidu_demo_connection_id !== ticket.connectionId)) fail('TICKET_ALREADY_USED');
    if (wallets.size !== 1) fail('WALLET_UNAVAILABLE');
    const wallet = wallets.docs[0], credits = Number(wallet.data().credits);
    if (!Number.isFinite(credits) || credits < 2) fail('INSUFFICIENT_CREDITS');
    const maxSeconds = Math.min(ticket.maxSeconds, Math.floor(credits / 2), Number(row.provider_max_seconds) || 7200, 7200);
    const startedAt = Number.isSafeInteger(row.vidu_demo_started_at) ? row.vidu_demo_started_at : now;
    const startupDeadline = Math.min(startedAt + startupMs, ticket.providerExpiresAt);
    if (startupDeadline <= now || maxSeconds < 1) fail('EXPIRED_TICKET');
    tx.update(sessionRef, {
      vidu_demo_lease_id: leaseId, vidu_demo_connection_id: ticket.connectionId,
      vidu_demo_attempts: Number(row.vidu_demo_attempts || 0) + 1, vidu_demo_started_at: startedAt,
    });
    return { leaseId, sessionRef, profileRef, walletRef: wallet.ref, maxSeconds, startupDeadline };
  });
}

export async function releaseViduDemoLease(db, lease) {
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(lease.sessionRef);
    if (snapshot.data()?.vidu_demo_lease_id === lease.leaseId) tx.update(lease.sessionRef, { vidu_demo_lease_id: null });
  });
}

export async function initializeViduDemoLease(db, lease, userId) {
  return db.runTransaction(async tx => {
    const [snapshot, profile] = await Promise.all([tx.get(lease.sessionRef), tx.get(lease.profileRef)]);
    if (!authorized(snapshot.data(), userId) || profile.data()?.account_status !== 'active'
      || snapshot.data().vidu_demo_lease_id !== lease.leaseId) fail('SESSION_UNAVAILABLE');
    tx.update(lease.sessionRef, { vidu_demo_initialized: true });
  });
}

export function createViduDemoProxyServer({
  supabase, secret = process.env.VIDU_DEMO_PROXY_SECRET, apiKey = process.env.VIDU_API_KEY,
  environment = process.env, audience = getViduDemoAudience(environment),
  createUpstream = (url, options) => new WebSocket(url, options), waitUntil = () => {},
  logger = console,
  now = Date.now, startupMs = 120000, drainMs = 500, authenticationMs = 5000, cleanupMs = 5000,
} = {}) {
  startupMs = Math.max(1, Math.min(120000, startupMs));
  drainMs = Math.max(1, Math.min(1000, drainMs));
  cleanupMs = Math.max(1, Math.min(5000, cleanupMs));
  const configured = () => isViduDemoProxyEnabled(environment) && supabase?.db && apiKey?.trim()
    && hasViduDemoProxySecret(secret) && audience;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const validPath = req.url === PATH;
    if (!isViduDemoProxyEnabled(environment) || !validPath) {
      res.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return;
    }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'Method not allowed' })); return; }
    res.writeHead(configured() ? 426 : 503).end(JSON.stringify({ error: configured() ? 'WebSocket required' : 'Plus signaling unavailable' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has('morphly.plus') ? 'morphly.plus' : false });
  server.viduDemoSockets = wss;

  server.on('upgrade', async (req, socket, head) => {
    let lease, timeout, cancelled = false, upgraded = false;
    const reject = status => {
      if (socket.destroyed) return;
      socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : status === 503 ? 'Service Unavailable' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.once('close', () => {
      cancelled = true;
      if (lease && !upgraded) void releaseViduDemoLease(supabase.db, lease).catch(() => {});
    });
    if (!isViduDemoProxyEnabled(environment) || req.url !== PATH) { reject(404); return; }
    if (!configured()) { reject(503); return; }
    let payload;
    try {
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket'
        || req.headers['sec-websocket-version'] !== '13'
        || !/^[+/0-9A-Za-z]{22}==$/.test(req.headers['sec-websocket-key'] || '')) fail('INVALID_UPGRADE');
      const protocolHeader = req.headers['sec-websocket-protocol'];
      if (typeof protocolHeader !== 'string' || protocolHeader.length > 12500) fail('INVALID_TICKET');
      const protocols = protocolHeader.split(',').map(p => p.trim());
      const ticketProtocol = protocols.find(p => p.startsWith('morphly-ticket.'));
      if (protocols.length !== 2 || !protocols.includes('morphly.plus') || !ticketProtocol) fail('INVALID_TICKET');
      payload = validateViduDemoTicket(ticketProtocol.slice('morphly-ticket.'.length), {
        secret, audience, origin: canonicalRelayOrigin(req.headers.origin), now: now(),
      });
      const pending = claimViduDemoLease(supabase.db, payload, { now: now(), startupMs });
      // A database transaction cannot be cancelled. Release a late claim if the
      // HTTP socket or authorization deadline has already ended.
      const lateCleanup = pending.then(claimed => cancelled ? releaseViduDemoLease(supabase.db, claimed).catch(() => {}) : undefined, () => {});
      waitUntil(lateCleanup);
      lease = await Promise.race([pending, new Promise((_, rejectPromise) => {
        timeout = setTimeout(() => { cancelled = true; rejectPromise(new Error('AUTH_TIMEOUT')); }, authenticationMs);
      })]);
      clearTimeout(timeout);
      if (cancelled || socket.destroyed) { void releaseViduDemoLease(supabase.db, lease).catch(() => {}); return; }
      wss.handleUpgrade(req, socket, head, client => {
        upgraded = true;
        runConnection(client, req, payload, lease);
      });
    } catch {
      clearTimeout(timeout);
      if (lease) void releaseViduDemoLease(supabase.db, lease).catch(() => {});
      reject(403);
    }
  });

  function runConnection(client, req, payload, lease) {
    let upstream, closed = false, ready = false, hangupSent = false, lastSequence = 0, pendingClientHangup;
    let upstreamStatus;
    const startedAt = now();
    const diagnostic = (event, metadata = {}) => {
      try { logger?.info?.('[Vidu] relay', { event, elapsedMs: Math.max(0, now() - startedAt), ...metadata }); } catch {}
    };
    let queue = [], queueBytes = 0, incomingBytes = 0, incoming = Promise.resolve(), lastSend = Promise.resolve();
    let activeTimer, expiryTimer, startupTimer, resolveLifetime;
    const subscriptions = [];
    const lifetime = new Promise(resolve => { resolveLifetime = resolve; });
    waitUntil(lifetime);

    function sendUpstream(data, binary, terminal = false) {
      if (!terminal && upstream.bufferedAmount > MAX_BUFFER) { finish('BUFFER_LIMIT', 1009); return; }
      // Only the final type-5 control may bypass the ordinary buffering budget;
      // the drain deadline still bounds its send and socket lifetime.
      if (terminal) hangupSent = true;
      lastSend = new Promise(resolve => {
        try { upstream.send(data, { binary }, error => { resolve(); if (error) finish('UPSTREAM_SEND', 1011); }); }
        catch { resolve(); finish('UPSTREAM_SEND', 1011); }
      });
    }
    function hangup() {
      if (hangupSent || upstream?.readyState !== WebSocket.OPEN) return;
      sendUpstream(pendingClientHangup || JSON.stringify({ type: 5, live_id: payload.liveId, conn_id: payload.connectionId,
        seq_id: lastSequence + 1, payload: { hangup: { hangup_reason: 'user_hangup' } } }), false, true);
    }
    function finish(reason, code = 1000) {
      if (closed) return;
      closed = true;
      diagnostic('closed', { reason, initialized: ready, ...(upstreamStatus ? { upstreamStatus } : {}) });
      clearTimeout(startupTimer); clearTimeout(activeTimer); clearTimeout(expiryTimer);
      for (const unsubscribe of subscriptions) { try { unsubscribe(); } catch {} }
      queue = []; queueBytes = 0;
      if (client.readyState === WebSocket.OPEN) client.close(code, CLOSED);
      // Preserve provider hangup before closing, but never delay cleanup beyond
      // the drain deadline or mutate the Morphly billing record here.
      const drained = new Promise(resolve => {
        let settled = false;
        const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { upstream?.terminate(); done(); }, drainMs);
        if (!upstream || upstream.readyState === WebSocket.CLOSED) { done(); return; }
        upstream.once('close', done);
        const end = () => {
          hangup();
          void lastSend.finally(() => {
            try { if (upstream.readyState === WebSocket.OPEN) upstream.close(1000); else if (upstream.readyState === WebSocket.CLOSED) done(); }
            catch { upstream.terminate(); done(); }
          });
        };
        if (upstream.readyState === WebSocket.OPEN) end();
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.once('open', end);
      });
      void drained.then(async () => {
        if (client.readyState !== WebSocket.CLOSED) client.terminate();
        let cleanupTimer;
        try {
          await Promise.race([releaseViduDemoLease(supabase.db, lease).catch(() => {}),
            new Promise(resolve => { cleanupTimer = setTimeout(resolve, cleanupMs); })]);
        } finally { clearTimeout(cleanupTimer); resolveLifetime(); }
      });
    }

    client.on('error', () => finish('CLIENT_ERROR', 1011));
    client.on('close', () => finish('CLIENT_CLOSED'));
    let rateSecond = Math.floor(now() / 1000), frames = 0;
    client.on('message', (data, isBinary) => {
      if (closed) return;
      if (payload.providerExpiresAt <= now()) { finish('EXPIRED', 1008); return; }
      const second = Math.floor(now() / 1000);
      if (second !== rateSecond) { rateSecond = second; frames = 0; }
      if (++frames > 60) { finish('RATE_LIMIT', 1008); return; }
      let isHangup = false;
      if (!isBinary) {
        let message;
        try { message = JSON.parse(data.toString()); } catch { finish('INVALID_MESSAGE', 1008); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || ![1, 5, 13].includes(message.type) || message.live_id !== payload.liveId || message.conn_id !== payload.connectionId
          || !Number.isSafeInteger(message.seq_id) || message.seq_id <= lastSequence || message.seq_id >= Number.MAX_SAFE_INTEGER
          || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
          finish('INVALID_MESSAGE', 1008); return;
        }
        lastSequence = message.seq_id;
        isHangup = message.type === 5;
        if (isHangup && data.length > 4096) { finish('INVALID_MESSAGE', 1008); return; }
        if (isHangup) pendingClientHangup = data;
      }
      if (upstream?.readyState === WebSocket.OPEN) {
        sendUpstream(data, isBinary, isHangup);
      } else {
        queueBytes += data.length;
        if (queueBytes > MAX_PAYLOAD) { finish('BUFFER_LIMIT', 1009); return; }
        queue.push({ data, isBinary, isHangup });
      }
      if (isHangup) finish('CLIENT_HANGUP');
    });

    startupTimer = setTimeout(() => finish('STARTUP_TIMEOUT', 1011), Math.max(1, lease.startupDeadline - now()));
    expiryTimer = setTimeout(() => finish('PROVIDER_EXPIRED', 1008), Math.max(1, payload.providerExpiresAt - now()));
    try {
      const url = new URL(UPSTREAM);
      url.search = new URLSearchParams({ live_id: payload.liveId, conn_id: payload.connectionId, client_secret: payload.clientSecret }).toString();
      const key = apiKey.trim();
      upstream = createUpstream(url.toString(), {
        headers: { Authorization: /^Token\s/i.test(key) ? key : `Token ${key}`, Origin: payload.origin,
          'User-Agent': String(req.headers['user-agent'] || '').slice(0, 512) },
        maxPayload: MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: 10000, followRedirects: false,
      });
      diagnostic('upstream_connecting');
      upstream.on('error', () => finish('UPSTREAM_ERROR', 1011));
      upstream.on('unexpected-response', (_request, response) => {
        if (Number.isInteger(response.statusCode) && response.statusCode >= 400 && response.statusCode <= 599) upstreamStatus = response.statusCode;
        response.resume?.(); finish('UPSTREAM_REJECTED', 1011);
      });
      upstream.on('close', () => finish('UPSTREAM_CLOSED', 1011));
      upstream.on('open', () => {
        if (closed) return;
        diagnostic('upstream_open');
        for (const item of queue) { if (closed) break; sendUpstream(item.data, item.isBinary, item.isHangup); }
        queue = []; queueBytes = 0;
      });
      upstream.on('message', (data, isBinary) => {
        if (closed) return;
        incomingBytes += data.length;
        if (incomingBytes > MAX_BUFFER) { finish('BUFFER_LIMIT', 1009); return; }
        incoming = incoming.then(async () => {
          if (closed) return;
          if (payload.providerExpiresAt <= now()) { finish('PROVIDER_EXPIRED', 1008); return; }
          let message;
          if (!isBinary) { try { message = JSON.parse(data.toString()); } catch {} }
          if (message?.type === 2 && message.payload?.conn_init_ack?.success === true && !ready) {
            await initializeViduDemoLease(supabase.db, lease, payload.userId);
            if (closed) return;
            ready = true; clearTimeout(startupTimer);
            diagnostic('initialized');
            activeTimer = setTimeout(() => finish('SESSION_LIMIT'), lease.maxSeconds * 1000);
          }
          if (client.readyState !== WebSocket.OPEN) { finish('CLIENT_CLOSED'); return; }
          if (client.bufferedAmount > MAX_BUFFER) { finish('BUFFER_LIMIT', 1009); return; }
          client.send(data, { binary: Boolean(isBinary) }, error => { if (error) finish('CLIENT_SEND', 1011); });
          if (message?.type === 6) { hangupSent = true; finish('PROVIDER_HANGUP'); }
        }).catch(() => finish('SESSION_UNAVAILABLE', 1008)).finally(() => { incomingBytes -= data.length; });
      });
      const watch = (ref, check) => {
        if (!ref.onSnapshot) return;
        subscriptions.push(ref.onSnapshot(snapshot => { if (!closed && !check(snapshot.data())) finish('SESSION_UNAVAILABLE', 1008); }, () => finish('SESSION_UNAVAILABLE', 1011)));
      };
      watch(lease.sessionRef, row => authorized(row, payload.userId) && row.vidu_demo_lease_id === lease.leaseId);
      watch(lease.profileRef, row => row?.account_status === 'active');
      watch(lease.walletRef, row => Number.isFinite(Number(row?.credits)) && Number(row.credits) >= 2);
    } catch { finish('UPSTREAM_UNAVAILABLE', 1011); }
  }
  return server;
}
