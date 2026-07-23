import crypto from 'crypto';

export const REFERRAL_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6,12}$/;

export function normalizeReferralCode(value) {
  return String(value ?? '').trim().toUpperCase().slice(0, 12);
}

export function isReferralCodeFormatValid(value) {
  return REFERRAL_CODE_PATTERN.test(normalizeReferralCode(value));
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

export function getReferralRequestFingerprint(req, secret) {
  const forwardedFor = firstHeaderValue(req.headers?.['x-forwarded-for'])
    .split(',')[0]
    .trim();
  const remoteAddress = String(req.socket?.remoteAddress || req.ip || '').trim();
  const userAgent = firstHeaderValue(req.headers?.['user-agent']).slice(0, 300);
  const identity = `${forwardedFor || remoteAddress || 'unknown'}|${userAgent}`;
  const key = String(secret || 'morphly-referral-validation').slice(0, 256);

  return crypto.createHmac('sha256', key).update(identity).digest('hex');
}
