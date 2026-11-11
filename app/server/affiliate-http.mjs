import { affiliateError, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../../shared/affiliate-program.mjs';

const ALLOWED_ORIGINS = new Set([
  'https://live.morphly.fun',
  'https://morphly-alpha.vercel.app',
]);

export function assertAffiliateOrigin(req, env = process.env) {
  const origin = req.headers?.origin ?? req.headers?.Origin;
  if (origin == null || origin === '' || origin === 'null') return;
  let url;
  try { url = new URL(String(origin)); } catch { throw affiliateError('Untrusted origin', 403, 'UNTRUSTED_ORIGIN'); }
  if (url.origin !== origin) throw affiliateError('Untrusted origin', 403, 'UNTRUSTED_ORIGIN');
  const forwarded = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  const allowed = new Set(ALLOWED_ORIGINS);
  if (forwarded) allowed.add(`https://${forwarded}`);
  const configured = String(env.MORPHLY_PUBLIC_ORIGIN || env.VITE_PUBLIC_APP_URL || '').replace(/\/$/, '');
  if (configured.startsWith('https://')) allowed.add(configured);
  if (url.protocol === 'https:' && allowed.has(url.origin)) return;
  const dev = env.NODE_ENV !== 'production' && !env.VERCEL;
  if (dev && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return;
  throw affiliateError('Untrusted origin', 403, 'UNTRUSTED_ORIGIN');
}

export function assertJsonPost(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return;
  const type = String(req.headers?.['content-type'] || '');
  if (!type.toLowerCase().includes('application/json')) {
    throw affiliateError('Content-Type must be application/json', 415, 'UNSUPPORTED_MEDIA');
  }
}

export function assertCaller(req, userId) {
  const body = req.body || {};
  const query = req.query || {};
  const claimed = [body.userId, body.affiliateId, body.referredUserId, body.adminId, query.userId, query.id, query.affiliateId];
  if (claimed.some((value) => value && String(value) !== String(userId))) {
    throw affiliateError('User mismatch', 403, 'USER_MISMATCH');
  }
}

export async function consumeRateLimit(db, userId, action, nowMs = Date.now()) {
  const ref = db.collection('affiliate_rate_limits').doc(`${action}:${userId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const attempts = (snap.exists ? snap.data().attempts || [] : []).filter((stamp) => nowMs - stamp < RATE_LIMIT_WINDOW_MS);
    if (attempts.length >= RATE_LIMIT_MAX) {
      throw affiliateError('Too many attempts. Please wait and try again.', 429, 'RATE_LIMITED');
    }
    tx.set(ref, { attempts: [...attempts, nowMs].slice(-RATE_LIMIT_MAX), updated_at: new Date(nowMs).toISOString() });
  });
}
