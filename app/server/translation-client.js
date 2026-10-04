import WebSocket from 'ws';
import { createTranslationAudioQueue } from '../shared/translation-audio-queue.js';

export function connectTranslation({ gatewayUrl, accessToken, targetLanguage, incoming, onAudio, onError,
  onState = () => {}, retryBaseMs = 500, retryWindowMs = 45000, handshakeMs = 20000 }) {
  const url = new URL(gatewayUrl);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Translation requires a secure server connection.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid translation server URL.');
  if (!accessToken) throw new Error('Sign in to use translation.');
  let active, candidate, stopping = false, handingOff = false;
  let reconnectTimer, retryDeadline, pumpTimer, attempts = 0;
  let reportedState;
  const queue = createTranslationAudioQueue();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  function report(state) { if (reportedState !== state) { reportedState = state; onState(state); } }
  function dispose(connection, graceful = false) {
    if (!connection || connection.disposed) return;
    connection.disposed = true;
    clearTimeout(connection.timeout);
    const socket = connection.socket;
    if (socket.readyState === WebSocket.CLOSED) return;
    if (graceful && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop' })); socket.close();
      const deadline = setTimeout(() => socket.terminate(), 1500);
      deadline.unref?.(); socket.once('close', () => clearTimeout(deadline));
    } else socket.terminate();
  }
  function fail(message) {
    if (stopping) return;
    stopping = true;
    clearTimeout(reconnectTimer); clearTimeout(retryDeadline); clearTimeout(pumpTimer);
    queue.clear(); dispose(active); dispose(candidate);
    rejectReady(new Error(message)); onError(message);
  }
  function recovery() {
    report('reconnecting');
    if (!retryDeadline) retryDeadline = setTimeout(() => fail('Translation could not reconnect. Check your internet connection and start again.'), retryWindowMs);
  }
  function retry() {
    if (stopping || reconnectTimer) return;
    recovery();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!active) open();
    }, Math.min(retryBaseMs * 2 ** Math.min(attempts++, 4), 4000));
  }
  function activateCandidate() {
    if (!candidate?.prepared || stopping) return;
    dispose(active); active = candidate; candidate = undefined;
    active.standby = false; handingOff = false;
    const replacement = active;
    active.timeout = setTimeout(() => lost(replacement), handshakeMs);
    active.socket.send(JSON.stringify({ type: 'activate' }));
  }
  function lost(connection) {
    if (stopping || !connection || connection.disposed) return;
    dispose(connection);
    if (connection === candidate) {
      candidate = undefined;
      if (active?.ready && !handingOff) return; // Current audio stays live if preparation failed.
    } else if (connection === active) {
      active = undefined; handingOff = false;
      onAudio({ type: 'clear', direction: 'outgoing' });
      if (incoming) onAudio({ type: 'clear', direction: 'incoming' });
    }
    recovery();
    if (candidate?.prepared) activateCandidate();
    else if (!candidate) retry();
  }
  function pump() {
    if (stopping || pumpTimer || handingOff || !active?.ready || !queue.length) return;
    const connection = active;
    if (!connection.authorized) {
      if (!connection.beginSent) {
        connection.beginSent = true;
        connection.socket.send(JSON.stringify({ type: 'begin' }));
      }
      return;
    }
    if (connection.socket.readyState !== WebSocket.OPEN || connection.socket.bufferedAmount > 128 * 1024) { lost(connection); return; }
    const entry = queue.shift();
    if (!entry) return;
    connection.socket.send(JSON.stringify(entry.message));
    // Catch up at at most 2x PCM speed, with <=25 messages/s in two-way mode.
    // Do not burst a recovered buffer into Gemini or the gateway frame limiter.
    const delay = Math.max(40, entry.bytes / 32 / (incoming ? 4 : 2));
    pumpTimer = setTimeout(() => { pumpTimer = undefined; pump(); }, delay);
  }
  function open(handoffToken) {
    if (stopping) return;
    const connection = { socket: new WebSocket(url, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10000 }),
      standby: Boolean(handoffToken), ready: false, authorized: false, beginSent: false, prepared: false, disposed: false };
    if (connection.standby) candidate = connection; else active = connection;
    connection.timeout = setTimeout(() => lost(connection), handshakeMs);
    const socket = connection.socket;
    socket.on('open', () => {
      if (!connection.disposed && !stopping) socket.send(JSON.stringify({ type: 'auth', accessToken, targetLanguage, incoming, protocolVersion: 3, handoffToken }));
    });
    socket.on('message', raw => {
      if (stopping || connection.disposed) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'prepared' && connection === candidate) {
          clearTimeout(connection.timeout); connection.prepared = true;
          if (!active) { activateCandidate(); return; }
          // Switch capture only after the replacement setup ACK. Continue playing
          // the old socket while it drains and closes its durable billing lease.
          handingOff = true; recovery();
          active.socket.send(JSON.stringify({ type: 'drain' }));
          const old = active;
          old.timeout = setTimeout(() => lost(old), handshakeMs);
        } else if (message.type === 'stopped' && handingOff && connection === active) {
          activateCandidate();
        } else if (message.type === 'ready' && connection === active) {
          clearTimeout(connection.timeout);
          connection.ready = true; connection.authorized = message.protocolVersion !== 3;
          resolveReady();
          if (connection.authorized) healthy();
          else report('connected');
          pump();
        } else if (message.type === 'authorized' && connection === active && connection.ready) {
          connection.authorized = true; healthy(); pump();
        } else if (message.type === 'rotate' && connection === active && !candidate && !handingOff) {
          open(message.handoffToken);
        } else if (message.type === 'reconnect' || (message.type === 'error' && message.retryable)) lost(connection);
        else if (message.type === 'error') {
          if (connection === candidate && active?.ready && !handingOff) lost(connection);
          else fail(message.message || 'Translation failed.');
        } else if (connection === active && connection.ready && (message.type === 'audio' || message.type === 'clear')) onAudio(message);
      } catch { fail('Invalid translation response.'); }
    });
    socket.on('error', () => lost(connection));
    socket.on('close', () => lost(connection));
    return connection;
  }
  function healthy() {
    clearTimeout(retryDeadline); retryDeadline = undefined;
    attempts = 0; report('connected');
  }
  open();
  return {
    ready,
    send(message) { if (!stopping) { queue.push(message); pump(); } },
    close() {
      if (stopping) return;
      stopping = true;
      clearTimeout(reconnectTimer); clearTimeout(retryDeadline); clearTimeout(pumpTimer);
      queue.clear(); rejectReady(new Error('Translation stopped.'));
      dispose(active, true); dispose(candidate, true);
    },
  };
}
