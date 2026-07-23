// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import { logErrorEvent } from '../../../shared/backend-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    const userId = authResult.user.id;

    const [profileResult, referralsResult] = await Promise.all([
      supabaseAdmin
        .from('users')
        .select('referral_code')
        .eq('id', userId)
        .single(),
      supabaseAdmin
        .from('referrals')
        .select('id, status, created_at, qualified_at, rewarded_at, refund_warning')
        .eq('referrer_user_id', userId)
        .order('created_at', { ascending: false }),
    ]);

    if (profileResult.error) throw profileResult.error;
    if (referralsResult.error) throw referralsResult.error;

    const referrals = referralsResult.data || [];
    const qualifyingPurchaseCount = referrals.filter((entry) =>
      ['qualified', 'rewarded'].includes(entry.status)).length;
    const rewardedCount = referrals.filter((entry) => entry.status === 'rewarded').length;

    return res.json({
      referralCode: profileResult.data?.referral_code || '',
      referredCount: referrals.length,
      qualifyingPurchaseCount,
      rewardedCount,
      totalReferralCreditsEarned: rewardedCount * 200,
      referrals: referrals.map((entry) => ({
        id: entry.id,
        status: entry.status,
        createdAt: entry.created_at,
        qualifiedAt: entry.qualified_at,
        rewardedAt: entry.rewarded_at,
        refundWarning: Boolean(entry.refund_warning),
      })),
    });
  } catch (error) {
    await logErrorEvent('referrals.exception', error);
    return res.status(500).json({ error: 'Failed to load referral details' });
  }
}
