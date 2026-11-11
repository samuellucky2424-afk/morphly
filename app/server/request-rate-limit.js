const buckets = new Map();

export function rateLimit(key, { limit, windowMs, now = Date.now() } = {}) {
  if (!key || !limit || !windowMs) return true;
  const stamps = (buckets.get(key) || []).filter(stamp => now - stamp < windowMs);
  if (stamps.length >= limit) {
    buckets.set(key, stamps);
    return false;
  }
  stamps.push(now);
  buckets.set(key, stamps);
  if (buckets.size > 10000) buckets.delete(buckets.keys().next().value);
  return true;
}

function header(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Prefer the platform's real client address. The left-most X-Forwarded-For
// hop is caller-controlled, so the limiter uses the last hop instead.
export function trustedClientAddress(req) {
  const real = String(header(req, 'x-real-ip') || '').trim();
  if (real) return real.slice(0, 80);
  const parts = String(header(req, 'x-forwarded-for') || '').split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1].slice(0, 80);
  return String(req.socket?.remoteAddress || req.ip || 'unknown').slice(0, 80);
}
