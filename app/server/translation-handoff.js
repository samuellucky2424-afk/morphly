import { createHmac, timingSafeEqual } from 'node:crypto';

// Short-lived, user- and language-bound permission to prepare a standby socket.
// This grants no audio or credits; activation still uses the durable wallet RPC.
export function issueHandoff(key, claims, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...claims, expires: now + 30000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update('translation-handoff:' + payload).digest('base64url')}`;
}
export function verifyHandoff(key, token, expected, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return false;
  try {
    const [payload, signature, extra] = token.split('.');
    if (extra !== undefined) return false;
    const actual = Buffer.from(signature, 'base64url');
    const wanted = createHmac('sha256', key).update('translation-handoff:' + payload).digest();
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return claims.expires > now && claims.expires <= now + 30000
      && Object.entries(expected).every(([name, value]) => claims[name] === value);
  } catch { return false; }
}
