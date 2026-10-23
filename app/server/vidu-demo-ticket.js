import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

const AAD = Buffer.from('morphly.plus.proxy.v1');
const ACQUISITION_MS = 120000;
const MAX_TICKET_LENGTH = 12000;

export class ViduDemoTicketError extends Error {
  constructor(code = 'INVALID_TICKET') {
    super(code);
    this.name = 'ViduDemoTicketError';
    this.code = code;
  }
}

export function isViduDemoProxyEnabled(env = process.env) {
  return ['preview', 'production'].includes(env.VERCEL_ENV) && env.VIDU_DEMO_PROXY === 'true'
    && env.VIDU_API_BASE_URL === 'https://api.vidu.com';
}

export function getViduDemoAudience(env = process.env) {
  return typeof env.VERCEL_URL === 'string' ? env.VERCEL_URL.trim() : '';
}

function keyFromSecret(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new ViduDemoTicketError('INVALID_PROXY_SECRET');
  }
  const key = Buffer.from(secret, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== secret) {
    throw new ViduDemoTicketError('INVALID_PROXY_SECRET');
  }
  return key;
}

export function hasViduDemoProxySecret(secret) {
  try { keyFromSecret(secret); return true; } catch { return false; }
}

function text(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value);
}

// Electron renderers do not present a stable origin: packaged builds may send
// `null` or `file://`, development builds send http://localhost. Only exact
// HTTPS origins are meaningful bindings; every other value collapses to the
// opaque `null`. start-session only binds `null` for authenticated desktop
// callers, so web tickets (bound to HTTPS) cannot be redeemed this way.
export function canonicalRelayOrigin(origin) {
  if (typeof origin === 'string' && origin !== 'null') {
    try { const url = new URL(origin); if (url.protocol === 'https:' && url.origin === origin) return origin; } catch {}
  }
  return 'null';
}

function validOrigin(origin) {
  // Packaged Electron uses a file:// renderer. The authenticated session
  // handler alone authorizes this explicit opaque origin for desktop callers.
  if (origin === 'null') return true;
  try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin; } catch { return false; }
}

function validPayload(p) {
  return p?.version === 1 && text(p.userId) && text(p.sessionId) && text(p.liveId)
    && text(p.clientSecret, 4096) && text(p.connectionId) && text(p.audience, 253)
    && validOrigin(p.origin) && Number.isSafeInteger(p.issuedAt)
    && Number.isSafeInteger(p.expiresAt) && Number.isSafeInteger(p.providerExpiresAt)
    && p.expiresAt > p.issuedAt && p.expiresAt <= p.issuedAt + ACQUISITION_MS
    && p.providerExpiresAt >= p.expiresAt && p.providerExpiresAt <= 8.64e15
    && Number.isInteger(p.maxSeconds) && p.maxSeconds >= 1 && p.maxSeconds <= 7200;
}

export function issueViduDemoTicket({ secret, userId, sessionId, liveId, clientSecret,
  origin, audience, maxSeconds, providerExpiresAt, now = Date.now() }) {
  const key = keyFromSecret(secret);
  const providerExpiry = typeof providerExpiresAt === 'number' ? providerExpiresAt : Date.parse(providerExpiresAt);
  const payload = {
    version: 1, userId, sessionId, liveId, clientSecret, origin, audience,
    connectionId: randomUUID(), issuedAt: now,
    expiresAt: Math.min(now + ACQUISITION_MS, providerExpiry),
    providerExpiresAt: providerExpiry,
    maxSeconds: Math.max(1, Math.min(7200, Math.floor(Number(maxSeconds)))),
  };
  if (!validPayload(payload)) throw new ViduDemoTicketError();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const ticket = ['v1', nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  return { ticket, connectionId: payload.connectionId, expiresAt: new Date(payload.expiresAt).toISOString() };
}

export function validateViduDemoTicket(ticket, { secret, audience, origin, now = Date.now() } = {}) {
  const key = keyFromSecret(secret);
  let payload;
  try {
    if (typeof ticket !== 'string' || ticket.length > MAX_TICKET_LENGTH) throw new Error();
    const parts = ticket.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const [, nonceText, cipherText, tagText] = parts;
    const nonce = Buffer.from(nonceText, 'base64url'), tag = Buffer.from(tagText, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16 || parts.slice(1).some(part => Buffer.from(part, 'base64url').toString('base64url') !== part)) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(AAD); decipher.setAuthTag(tag);
    payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8'));
    if (!validPayload(payload) || !text(audience, 253) || payload.audience !== audience
      || (origin !== undefined && payload.origin !== origin) || payload.issuedAt > now + 5000) throw new Error();
  } catch { throw new ViduDemoTicketError(); }
  if (payload.expiresAt <= now || payload.providerExpiresAt <= now) throw new ViduDemoTicketError('EXPIRED_TICKET');
  return payload;
}
