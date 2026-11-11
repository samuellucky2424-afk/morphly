import crypto from 'crypto';

export const REFERRAL_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6,12}$/;

export function normalizeReferralCode(value) {
  return String(value ?? '').trim().toUpperCase().slice(0, 12);
}

export function isReferralCodeFormatValid(value) {
  return REFERRAL_CODE_PATTERN.test(normalizeReferralCode(value));
}

function trustedAddress(req) {
  const read = name => {
    const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const real = String(read('x-real-ip') || '').trim();
  if (real) return real.slice(0, 80);
  const parts = String(read('x-forwarded-for') || '').split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length) return parts[parts.length - 1].slice(0, 80);
  return String(req.socket?.remoteAddress || req.ip || 'unknown').slice(0, 80);
}

export function getReferralRequestFingerprint(req, secret) {
  const identity = trustedAddress(req);
  const key = String(secret || 'morphly-referral-validation').slice(0, 256);

  return crypto.createHmac('sha256', key).update(identity).digest('hex');
}
