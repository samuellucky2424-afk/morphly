// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import {
  getReferralRequestFingerprint,
  normalizeReferralCode,
} from '../../../shared/referrals.js';

function getRateLimitSecret() {
  return process.env.REFERRAL_RATE_LIMIT_SALT
    || process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH
    || process.env.FLW_SECRET_HASH
    || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  const code = normalizeReferralCode(req.query?.code);
  const requestHash = getReferralRequestFingerprint(req, getRateLimitSecret());

  try {
    const { data, error } = await supabaseAdmin.rpc('morphly_validate_referral_code', {
      p_code: code,
      p_request_hash: requestHash,
    });
    if (error) throw error;

    const valid = Boolean(data?.valid);
    const rateLimited = Boolean(data?.rateLimited);

    await logRequestEvent('referral-code.validated', {
      valid,
      rateLimited,
      codeLength: code.length,
    });

    if (rateLimited) {
      res.setHeader('Retry-After', '600');
      return res.status(429).json({
        valid: false,
        rateLimited: true,
        error: 'Too many referral-code checks. Please wait and try again.',
      });
    }

    return res.json({ valid, rateLimited: false });
  } catch (error) {
    await logErrorEvent('referral-code.exception', error);
    return res.status(500).json({ error: 'Unable to validate referral code' });
  }
}
