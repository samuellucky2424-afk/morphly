import { randomUUID } from 'node:crypto';

const XMAX_API_BASE_URL = 'https://api.xmax.ai/open/api/v1';
const relays = new Map();

// Same-process relay sockets can be hung up immediately. Other instances
// observe the ended session through their billing re-check.
export function registerViduRelay(sessionId, finish) {
  if (!sessionId || typeof finish !== 'function') return () => {};
  relays.set(sessionId, finish);
  return () => { if (relays.get(sessionId) === finish) relays.delete(sessionId); };
}

export function closeViduRelay(sessionId, reason = 'BILLING_STOP') {
  const finish = relays.get(sessionId);
  if (!finish) return false;
  try { finish(reason); } catch { /* the socket is already closing */ }
  return true;
}

export async function deactivateXmaxTemporaryKey({ apiKey, temporaryKey, fetchImpl = fetch } = {}) {
  if (!apiKey || typeof temporaryKey !== 'string' || !temporaryKey.startsWith('tk-')) return { ok: false };
  try {
    const response = await fetchImpl(`${XMAX_API_BASE_URL}/temporary-api-key/${encodeURIComponent(temporaryKey)}/inactive`, {
      method: 'PUT',
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(10000),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

export async function hangupViduLive({ apiKey, liveId, clientSecret, baseUrl = 'https://api.vidu.com' } = {}) {
  if (!apiKey || !liveId || !clientSecret) return { ok: false };
  const connectionId = randomUUID();
  let WebSocketImpl;
  try { WebSocketImpl = (await import('ws')).default; } catch { return { ok: false }; }
  const url = new URL('/live/ws/live/connect', baseUrl);
  url.protocol = 'wss:';
  url.search = new URLSearchParams({ live_id: String(liveId), conn_id: connectionId, client_secret: String(clientSecret) }).toString();
  await new Promise(resolve => {
    let socket;
    const done = () => { try { socket?.terminate(); } catch { /* already closed */ } resolve(); };
    const timer = setTimeout(done, 8000);
    try {
      socket = new WebSocketImpl(url.toString(), {
        headers: { Authorization: /^Token\s/i.test(apiKey) ? apiKey : `Token ${apiKey}` },
        handshakeTimeout: 8000,
      });
    } catch { clearTimeout(timer); done(); return; }
    socket.on('error', () => { clearTimeout(timer); done(); });
    socket.on('open', () => {
      try {
        socket.send(JSON.stringify({
          type: 5, live_id: String(liveId), conn_id: connectionId, seq_id: 1,
          payload: { hangup: { hangup_reason: 'user_hangup' } },
        }));
      } catch { /* the provider socket did not accept the hangup */ }
      setTimeout(() => { clearTimeout(timer); done(); }, 250);
    });
  });
  return { ok: true };
}

// Best-effort. Billing has already ended the Morphly session; a provider
// outage must not leave that session open or be retried into a second debit.
export async function revokeProviderSession(session, env = process.env) {
  if (!session) return;
  closeViduRelay(session.id || session.sessionId);
  try {
    if (session.provider === 'xmax') {
      await deactivateXmaxTemporaryKey({ apiKey: env.XMAX_API_KEY?.trim(), temporaryKey: session.provider_key_id || session.providerKeyId });
    } else if (session.provider === 'vidu') {
      await hangupViduLive({
        apiKey: env.VIDU_API_KEY?.trim(),
        liveId: session.provider_live_id || session.providerLiveId,
        clientSecret: session.provider_key_id || session.providerKeyId,
        baseUrl: env.VIDU_API_BASE_URL || 'https://api.vidu.com',
      });
    }
  } catch {
    /* revocation is best-effort after the wallet settlement */
  }
}
