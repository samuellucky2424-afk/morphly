import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { buildTranslationSetup, validateTranslationOptions } from '../shared/translation.js';
import { issueHandoff, verifyHandoff } from './translation-handoff.js';

const GEMINI_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function attachTranslationGateway(server, {
  supabase,
  apiKey = process.env.GEMINI_API_KEY,
  maxSessionMs = 0,
  renewalMs = 2000,
  handoffLeadMs = 30000,
  drainMs = 750,
  waitUntil = () => {},
  model = process.env.GEMINI_TRANSLATION_MODEL || 'gemini-3.5-live-translate-preview',
  createUpstream = () => new WebSocket(GEMINI_URL, { headers: { 'x-goog-api-key': apiKey }, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10000 }),
} = {}) {
  const wss = new WebSocketServer({ server, path: '/api/translation/live', maxPayload: 32 * 1024, perMessageDeflate: false });
  const users = new Set();
  const standbys = new Set();
  wss.on('connection', (client) => {
    let resolveLifetime;
    // Register while the upgrade request context is active. This keeps cleanup
    // alive on serverless hosts even if the client disconnects immediately.
    waitUntil(new Promise(resolve => { resolveLifetime = resolve; }));
    const sessionId = randomUUID();
    const upstreams = new Map();
    let userId, ownsUser = false, authenticated = false, ready = false, closed = false, protocolVersion = 1;
    let options, standby = false, ownsStandby = false, prepared = false, rotationSent = false, draining = false;
    let rotationTimer, standbyTimer, drainTimer;
    let startedAt = null, lastAudioAt = Date.now(), authorizedSeconds = 0;
    let renewTimer, expiryTimer, billing = Promise.resolve(), reservationPending = false;
    let billingUnavailable = false;
    let lastPong = Date.now();
    const firstForwarded = new Map(), firstReturned = new Set();
    let rateStart = Date.now(), frames = 0;
    const startupTimer = setTimeout(() => finish('Translation connection timed out.'), 20000);
    const sessionTimer = maxSessionMs > 0
      ? setTimeout(() => finish('Translation reached the server session limit. Reconnecting.', true), maxSessionMs)
      : undefined;
    const elapsed = () => startedAt === null ? 0 : Math.ceil((Date.now() - startedAt) / 1000);
    function requestHandoff() {
      if (closed || !ready || standby || rotationSent || protocolVersion < 3) return false;
      rotationSent = true;
      send(client, { type: 'rotate', handoffToken: issueHandoff(apiKey, { userId, targetLanguage: options.targetLanguage, incoming: options.incoming }) });
      return true;
    }
    function announceReady() {
      ready = true; lastAudioAt = Date.now();
      if (protocolVersion >= 3 && maxSessionMs > handoffLeadMs) {
        rotationTimer = setTimeout(requestHandoff, maxSessionMs - handoffLeadMs);
      }
      send(client, { type: 'ready', protocolVersion, sourceLanguage: 'en', targetLanguage: options.targetLanguage, creditsPerSecond: 2.5, combinedCreditsPerSecond: 4 });
    }
    const send = (socket, message) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 256 * 1024) { finish('The connection is too slow for live translation.', true); return; }
      socket.send(JSON.stringify(message));
    };
    function billingRpc(args) {
      const request = supabase.rpc('authorize_translation_usage', args);
      return typeof request.abortSignal === 'function' ? request.abortSignal(AbortSignal.timeout(4000)) : request;
    }
    async function reserve() {
      if (closed) return;
      const result = await Promise.resolve(billingRpc({
        p_user: userId, p_session: sessionId, p_seconds: Math.min(7200, Math.floor((Date.now() - startedAt) / 1000) + 5), p_close: false,
      })).catch(() => ({ status: 0, error: true }));
      if (result.error?.code === '23505') { finish('Previous translation session is still closing. Reconnecting.', true); return; }
      if (result.error && (result.status === 0 || result.status >= 500)) {
        billingUnavailable = true;
        if (authorizedSeconds === 0) finish('Credit service temporarily unavailable. Reconnecting.', true);
        return;
      }
      if (result.error || result.data?.closed) throw new Error('Unable to authorize translation credits.');
      billingUnavailable = false;
      authorizedSeconds = Number(result.data?.authorizedSeconds) || 0;
      if (Number.isFinite(result.data?.startedAtMs)) startedAt = result.data.startedAtMs;
      if (closed) return;
      clearTimeout(expiryTimer);
      const remainingMs = startedAt + authorizedSeconds * 1000 - Date.now();
      if (remainingMs <= 0) { finish('Not enough credits to continue translation.'); return; }
      expiryTimer = setTimeout(() => finish('Translation stopped because credit authorization expired.', billingUnavailable || reservationPending), remainingMs);
    }
    function queueReservation() {
      if (reservationPending || closed) return;
      reservationPending = true;
      billing = billing.then(reserve).catch(() => finish('Unable to authorize translation credits.'))
        .finally(() => { reservationPending = false; });
    }
    function finish(message, retryable = false) {
      if (closed) return;
      closed = true;
      const finalSeconds = Math.min(authorizedSeconds, elapsed());
      clearTimeout(startupTimer); clearTimeout(expiryTimer); clearInterval(renewTimer); clearInterval(watchdog);
      clearTimeout(sessionTimer);
      clearTimeout(rotationTimer); clearTimeout(standbyTimer); clearTimeout(drainTimer);
      if (ownsStandby) standbys.delete(userId);
      const notifyClient = () => {
        if (client.readyState !== WebSocket.OPEN) return;
        const type = retryable && protocolVersion >= 2 ? 'reconnect' : message ? 'error' : 'stopped';
        client.send(JSON.stringify({ type, message, retryable }));
        client.close(1000);
      };
      if (!retryable && !draining) notifyClient();
      for (const socket of upstreams.values()) { socket.on('error', () => {}); socket.terminate(); }
      // Serialize settlement after any pending reservation; retry idempotently.
      const settlement = startedAt !== null ? billing.then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await Promise.resolve(billingRpc({
            p_user: userId, p_session: sessionId, p_seconds: finalSeconds, p_close: true,
          })).catch(() => ({ error: true }));
          if (!result.error) return;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.error('Translation settlement needs retry:', sessionId);
      }) : Promise.resolve();
      void settlement.catch(() => console.error('Translation settlement failed:', sessionId)).finally(() => {
        // Release the in-memory lease only after the durable lease has closed.
        if (ownsUser) users.delete(userId);
        if (retryable || draining) notifyClient();
        resolveLifetime();
      });
    }
    const watchdog = setInterval(() => {
      if (Date.now() - lastPong > 10000) { finish(); client.terminate(); return; }
      if (client.readyState === WebSocket.OPEN) client.ping();
      // CPU calibration/reference preparation happens before capture opens.
      // Allow that startup work without charging; once audio flows, fail fast.
      const idleLimit = startedAt === null ? 90000 : 10000;
      if (ready && Date.now() - lastAudioAt > idleLimit) finish('No audio received. Translation stopped.');
    }, 2000);
    client.on('pong', () => { lastPong = Date.now(); });
    async function openDirection(direction, language) {
      const socket = createUpstream();
      upstreams.set(direction, socket);
      return new Promise((resolve, reject) => {
        socket.on('open', () => send(socket, buildTranslationSetup(language, model)));
        socket.on('error', () => { reject(new Error('Gemini connection failed.')); finish('Gemini connection failed. Reconnecting.', true); });
        socket.on('close', () => { reject(new Error('Gemini disconnected.')); finish('Gemini disconnected. Reconnecting.', true); });
        socket.on('message', (raw) => {
          try {
            const message = JSON.parse(raw.toString());
            if (message.setupComplete) resolve();
            if (message.error) { finish('Gemini rejected the translation session. Check the server model and API configuration.'); return; }
            if (message.goAway) {
              if (!requestHandoff() && !rotationSent) finish('Gemini is renewing the translation session. Reconnecting.', true);
              return;
            }
            if (startedAt === null || closed) return;
            if (message.serverContent?.interrupted) send(client, { type: 'clear', direction });
            for (const part of message.serverContent?.modelTurn?.parts || []) {
              if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data) {
                if (!firstReturned.has(direction) && firstForwarded.has(direction)) {
                  firstReturned.add(direction);
                  // Includes any initial silence; not a measurement of speech latency.
                  console.info('translation.first_audio', JSON.stringify({ direction, sinceFirstForwardMs: Date.now() - firstForwarded.get(direction) }));
                }
                send(client, { type: 'audio', direction, data: part.inlineData.data, sampleRate: 24000 });
              }
            }
          } catch { finish('Invalid response from the translation service.'); }
        });
      });
    }
    client.on('message', async (raw) => {
      if (closed) return;
      const receivedAt = Date.now();
      try {
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          if (message.type !== 'auth' || typeof message.accessToken !== 'string' || message.accessToken.length > 8192) throw new Error('Sign in to use translation.');
          authenticated = true; // A second handshake cannot start concurrent sessions.
          protocolVersion = [2, 3].includes(message.protocolVersion) ? message.protocolVersion : 1;
          if (!apiKey || !supabase) throw new Error('Real-time translation is not configured on the server.');
          options = validateTranslationOptions({ ...message, enabled: true });
          const { data, error } = await supabase.auth.getUser(message.accessToken);
          if (closed) return;
          if (error || !data?.user) throw new Error('Your sign-in has expired. Sign in again.');
          userId = data.user.id;
          standby = Boolean(message.handoffToken);
          if (standby) {
            if (protocolVersion < 3 || !verifyHandoff(apiKey, message.handoffToken, { userId, targetLanguage: options.targetLanguage, incoming: options.incoming })) {
              throw new Error('Invalid or expired translation handoff.');
            }
            if (standbys.has(userId)) { finish('Translation replacement is already preparing.', true); return; }
            standbys.add(userId); ownsStandby = true;
            standbyTimer = setTimeout(() => finish('Translation replacement was not activated.', true), 30000);
          } else {
            if (users.has(userId)) { finish('Translation is already running or finishing for this account. Retrying.', true); return; }
            users.add(userId); ownsUser = true;
          }
          await Promise.all([
            openDirection('outgoing', options.targetLanguage),
            ...(options.incoming ? [openDirection('incoming', 'en')] : []),
          ]);
          if (closed) return;
          clearTimeout(startupTimer);
          prepared = true;
          if (standby) send(client, { type: 'prepared' });
          else announceReady();
          return;
        }
        if (message.type === 'stop') { finish(); return; }
        if (message.type === 'activate' && standby && prepared) {
          if (users.has(userId)) { finish('Previous translation session is still closing.', true); return; }
          users.add(userId); ownsUser = true;
          standbys.delete(userId); ownsStandby = false; standby = false;
          clearTimeout(standbyTimer); announceReady(); return;
        }
        if (!ready || closed) return;
        if (message.type === 'drain' && protocolVersion >= 3) {
          if (!draining) { draining = true; drainTimer = setTimeout(() => finish(), drainMs); }
          return;
        }
        if (draining) return;
        if (message.type === 'begin' && protocolVersion >= 3) {
          if (startedAt === null) {
            startedAt = Date.now();
            expiryTimer = setTimeout(() => finish('Translation credit authorization timed out.'), 5000);
            queueReservation(); renewTimer = setInterval(queueReservation, renewalMs);
            void billing.then(() => { if (!closed) send(client, { type: 'authorized' }); });
          }
          return;
        }
        if (message.type !== 'audio' || !upstreams.has(message.direction)
          || typeof message.data !== 'string' || message.data.length > 12000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) throw new Error('Invalid translation audio.');
        if (Date.now() - rateStart >= 1000) { rateStart = Date.now(); frames = 0; }
        if (++frames > 40) throw new Error('Translation audio is arriving too quickly.');
        lastAudioAt = Date.now();
        if (protocolVersion >= 3 && startedAt === null) throw new Error('Authorize translation before sending audio.');
        if (startedAt === null) {
          startedAt = Date.now();
          expiryTimer = setTimeout(() => finish('Translation credit authorization timed out.'), 5000);
          queueReservation();
          renewTimer = setInterval(queueReservation, renewalMs);
        }
        // v3 authorizes using the separate begin/authorized exchange. The audio
        // path only reads the cached deadline; older clients retain startup gating.
        if (protocolVersion < 3 && authorizedSeconds === 0) await billing;
        // Credit checks must not turn into a backlog of stale speech.
        if (!closed && Date.now() - receivedAt <= 320 && Date.now() < startedAt + authorizedSeconds * 1000) {
          if (!firstForwarded.has(message.direction)) firstForwarded.set(message.direction, Date.now());
          send(upstreams.get(message.direction), { realtimeInput: { audio: { data: message.data, mimeType: 'audio/pcm;rate=16000' } } });
        }
      } catch (error) { finish(error.message || 'Translation failed.'); }
    });
    client.on('error', () => finish());
    client.on('close', () => finish());
  });
  return wss;
}
