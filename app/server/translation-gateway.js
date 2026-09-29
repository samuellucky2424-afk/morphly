import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { buildTranslationSetup, validateTranslationOptions } from '../shared/translation.js';

const GEMINI_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function attachTranslationGateway(server, {
  supabase,
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_TRANSLATION_MODEL || 'gemini-3.5-live-translate-preview',
  createUpstream = () => new WebSocket(GEMINI_URL, { headers: { 'x-goog-api-key': apiKey }, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10000 }),
} = {}) {
  const wss = new WebSocketServer({ server, path: '/api/translation/live', maxPayload: 32 * 1024, perMessageDeflate: false });
  const users = new Set();
  wss.on('connection', (client) => {
    const sessionId = randomUUID();
    const upstreams = new Map();
    let userId, ownsUser = false, authenticated = false, ready = false, closed = false;
    let startedAt = null, lastAudioAt = Date.now(), authorizedSeconds = 0;
    let renewTimer, expiryTimer, billing = Promise.resolve();
    let rateStart = Date.now(), frames = 0;
    const startupTimer = setTimeout(() => finish('Translation connection timed out.'), 20000);
    const elapsed = () => startedAt === null ? 0 : Math.ceil((Date.now() - startedAt) / 1000);
    const send = (socket, message) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 256 * 1024) { finish('The connection is too slow for live translation.'); return; }
      socket.send(JSON.stringify(message));
    };
    async function reserve() {
      if (closed) return;
      const result = await supabase.rpc('authorize_translation_usage', {
        p_user: userId, p_session: sessionId, p_seconds: Math.min(7200, Math.floor((Date.now() - startedAt) / 1000) + 5), p_close: false,
      });
      if (result.error || result.data?.closed) throw new Error('Unable to authorize translation credits.');
      authorizedSeconds = Number(result.data?.authorizedSeconds) || 0;
      if (Number.isFinite(result.data?.startedAtMs)) startedAt = result.data.startedAtMs;
      if (closed) return;
      clearTimeout(expiryTimer);
      const remainingMs = startedAt + authorizedSeconds * 1000 - Date.now();
      if (remainingMs <= 0) { finish('Not enough credits to continue translation.'); return; }
      expiryTimer = setTimeout(() => finish('Translation stopped because credit authorization expired.'), remainingMs);
    }
    function queueReservation() {
      billing = billing.then(reserve).catch(() => finish('Unable to authorize translation credits.'));
    }
    function finish(message) {
      if (closed) return;
      closed = true;
      const finalSeconds = Math.min(authorizedSeconds, elapsed());
      clearTimeout(startupTimer); clearTimeout(expiryTimer); clearInterval(renewTimer); clearInterval(watchdog);
      if (ownsUser) users.delete(userId);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: message ? 'error' : 'stopped', message }));
        client.close(1000);
      }
      for (const socket of upstreams.values()) { socket.on('error', () => {}); socket.terminate(); }
      // Serialize settlement after any pending reservation; retry idempotently.
      if (startedAt !== null) void billing.then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await supabase.rpc('authorize_translation_usage', {
            p_user: userId, p_session: sessionId, p_seconds: finalSeconds, p_close: true,
          }).catch(() => ({ error: true }));
          if (!result.error) return;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.error('Translation settlement needs retry:', sessionId);
      });
    }
    const watchdog = setInterval(() => {
      // CPU calibration/reference preparation happens before capture opens.
      // Allow that startup work without charging; once audio flows, fail fast.
      const idleLimit = startedAt === null ? 90000 : 10000;
      if (ready && Date.now() - lastAudioAt > idleLimit) finish('No audio received. Translation stopped.');
    }, 2000);
    async function openDirection(direction, language) {
      const socket = createUpstream();
      upstreams.set(direction, socket);
      return new Promise((resolve, reject) => {
        socket.on('open', () => send(socket, buildTranslationSetup(language, model)));
        socket.on('error', () => { reject(new Error('Gemini connection failed.')); finish('Gemini connection failed.'); });
        socket.on('close', () => { reject(new Error('Gemini disconnected.')); finish('Gemini disconnected. Start translation again to reconnect.'); });
        socket.on('message', (raw) => {
          try {
            const message = JSON.parse(raw.toString());
            if (message.setupComplete) resolve();
            if (message.error || message.goAway) { finish('Gemini ended the translation session. Start translation again to reconnect.'); return; }
            if (startedAt === null || closed) return;
            if (message.serverContent?.interrupted) send(client, { type: 'clear', direction });
            for (const part of message.serverContent?.modelTurn?.parts || []) {
              if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data) {
                send(client, { type: 'audio', direction, data: part.inlineData.data, sampleRate: 24000 });
              }
            }
          } catch { finish('Invalid response from the translation service.'); }
        });
      });
    }
    client.on('message', async (raw) => {
      const receivedAt = Date.now();
      try {
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          if (message.type !== 'auth' || typeof message.accessToken !== 'string' || message.accessToken.length > 8192) throw new Error('Sign in to use translation.');
          authenticated = true; // A second handshake cannot start concurrent sessions.
          if (!apiKey || !supabase) throw new Error('Real-time translation is not configured on the server.');
          const options = validateTranslationOptions({ ...message, enabled: true });
          const { data, error } = await supabase.auth.getUser(message.accessToken);
          if (closed) return;
          if (error || !data?.user) throw new Error('Your sign-in has expired. Sign in again.');
          userId = data.user.id;
          if (users.has(userId)) throw new Error('Translation is already running for this account.');
          users.add(userId); ownsUser = true;
          await Promise.all([
            openDirection('outgoing', options.targetLanguage),
            ...(options.incoming ? [openDirection('incoming', 'en')] : []),
          ]);
          if (closed) return;
          ready = true; lastAudioAt = Date.now();
          clearTimeout(startupTimer);
          send(client, { type: 'ready', sourceLanguage: 'en', targetLanguage: options.targetLanguage, creditsPerSecond: 2.5, combinedCreditsPerSecond: 4 });
          return;
        }
        if (message.type === 'stop') { finish(); return; }
        if (!ready || closed) return;
        if (message.type !== 'audio' || !upstreams.has(message.direction)
          || typeof message.data !== 'string' || message.data.length > 12000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) throw new Error('Invalid translation audio.');
        if (Date.now() - rateStart >= 1000) { rateStart = Date.now(); frames = 0; }
        if (++frames > 40) throw new Error('Translation audio is arriving too quickly.');
        lastAudioAt = Date.now();
        if (startedAt === null) {
          startedAt = Date.now();
          expiryTimer = setTimeout(() => finish('Translation credit authorization timed out.'), 5000);
          queueReservation();
          renewTimer = setInterval(queueReservation, 2000);
        }
        await billing;
        // Credit checks must not turn into a backlog of stale speech.
        if (!closed && Date.now() - receivedAt <= 320 && Date.now() < startedAt + authorizedSeconds * 1000) {
          send(upstreams.get(message.direction), { realtimeInput: { audio: { data: message.data, mimeType: 'audio/pcm;rate=16000' } } });
        }
      } catch (error) { finish(error.message || 'Translation failed.'); }
    });
    client.on('error', () => finish());
    client.on('close', () => finish());
  });
  return wss;
}
