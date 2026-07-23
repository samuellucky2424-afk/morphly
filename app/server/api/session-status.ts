// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

const CREDITS_PER_SECOND = 2;

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? credits : 0;
}

function normalizeSeconds(value) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    const requestedUserId = req.query.userId || req.query.id;
    const userId = authResult.user.id;
    if (requestedUserId && requestedUserId !== userId) {
      return res.status(403).json({ error: 'User mismatch' });
    }

    await logRequestEvent('session-status.request', {
      method: req.method,
      path: '/api/session-status',
      userId,
    });

    const [walletResult, activeSessionResult] = await Promise.all([
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
      supabaseAdmin
        .from('sessions')
        .select('id, seconds_used')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (walletResult.error) {
      console.error('Failed to load wallet for session-status:', walletResult.error);
      return res.status(500).json({ error: 'Failed to load wallet' });
    }

    if (activeSessionResult.error) {
      console.error('Failed to load active session for session-status:', activeSessionResult.error);
      return res.status(500).json({ error: 'Failed to load active session' });
    }

    const walletData = walletResult.data;
    const activeSession = activeSessionResult.data;

    const walletCredits = normalizeCredits(walletData?.credits);

    if (!activeSession) {
      return res.json({ credits: walletCredits, remainingCredits: walletCredits, shouldStop: walletCredits <= 0 });
    }

    // Compute live balance from Decart generation seconds recorded by heartbeat.
    // The wallet is still deducted only once in end-session.
    const billableSeconds = normalizeSeconds(activeSession.seconds_used);
    const liveDeducted = Math.min(walletCredits, billableSeconds * CREDITS_PER_SECOND);
    const remainingCredits = Math.max(0, walletCredits - liveDeducted);
    const shouldStop = remainingCredits <= 0;

    return res.json({
      credits: remainingCredits,
      remainingCredits,
      billableSeconds,
      shouldStop,
      forceEnd: shouldStop,
    });
  } catch (error) {
    console.error('session-status unexpected error:', error);
    await logErrorEvent('session-status.exception', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
