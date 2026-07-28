// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

const HEARTBEAT_SECONDS = 30;
const CREDITS_PER_SECOND = 2;
const MAX_SECONDS_PER_HEARTBEAT = 60;

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? credits : 0;
}

function normalizeSeconds(value) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

function normalizeHeartbeatSeconds(value) {
  const seconds = Number(value ?? HEARTBEAT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return Math.min(Math.floor(seconds), MAX_SECONDS_PER_HEARTBEAT);
}

function isMissingUsageRpc(error) {
  const message = String(error?.message || error?.details || error?.hint || '');
  return ['PGRST202', '42883'].includes(error?.code) ||
    /record_ai_session_usage|schema cache|function .* does not exist/i.test(message);
}

async function updateSessionUsage(sessionId, secondsUsed, creditsUsed) {
  const updateWithCost = await supabaseAdmin
    .from('sessions')
    .update({ seconds_used: secondsUsed, cost: creditsUsed })
    .eq('id', sessionId)
    .eq('status', 'active');

  if (!updateWithCost.error) {
    return updateWithCost;
  }

  const message = String(updateWithCost.error?.message || updateWithCost.error?.details || '');
  if (updateWithCost.error?.code !== 'PGRST204' && !/cost/i.test(message)) {
    return updateWithCost;
  }

  return supabaseAdmin
    .from('sessions')
    .update({ seconds_used: secondsUsed, credits_used: creditsUsed })
    .eq('id', sessionId)
    .eq('status', 'active');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError });

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    const userId = authResult.user.id;
    const requestedUserId = req.body?.userId;
    const sessionId = req.body?.sessionId;
    if (requestedUserId && requestedUserId !== userId) {
      return res.status(403).json({ error: 'User mismatch' });
    }
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const secondsDelta = normalizeHeartbeatSeconds(req.body?.secondsDelta ?? req.body?.seconds);
    if (secondsDelta <= 0) {
      return res.status(400).json({ error: 'secondsDelta must be greater than 0' });
    }

    // New deployments debit the wallet and update the durable ledger in the
    // same database transaction. Keep the legacy path temporarily so the API
    // can be deployed immediately before the SQL migration is applied.
    const usageRpc = await supabaseAdmin.rpc('record_ai_session_usage', {
      p_user: userId,
      p_session: sessionId,
      p_seconds_delta: secondsDelta,
    });

    if (!usageRpc.error) {
      return res.json(usageRpc.data);
    }

    if (!isMissingUsageRpc(usageRpc.error)) {
      throw usageRpc.error;
    }

    const [{ data: walletData, error: walletError }, { data: sessionData, error: sessionError }] = await Promise.all([
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
      supabaseAdmin
        .from('sessions')
        .select('id, seconds_used, status')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle(),
    ]);

    if (walletError) {
      return res.status(500).json({ error: 'Failed to load wallet' });
    }

    if (sessionError) {
      return res.status(500).json({ error: 'Failed to load session' });
    }

    if (!sessionData) {
      return res.json({ shouldStop: true, reason: 'session_not_found', remainingCredits: 0 });
    }

    const currentCredits = normalizeCredits(walletData?.credits);
    const currentSecondsUsed = normalizeSeconds(sessionData.seconds_used);
    const maxBillableSeconds = Math.ceil(currentCredits / CREDITS_PER_SECOND);
    const secondsToRecord = Math.min(secondsDelta, Math.max(0, maxBillableSeconds - currentSecondsUsed));

    if (currentCredits <= 0 || secondsToRecord <= 0) {
      return res.json({ shouldStop: true, reason: 'no_credits', remainingCredits: 0 });
    }

    const newSecondsUsed = currentSecondsUsed + secondsToRecord;
    const recordedCreditsUsed = newSecondsUsed * CREDITS_PER_SECOND;
    const remainingCredits = Math.max(0, currentCredits - recordedCreditsUsed);

    const updateResult = await updateSessionUsage(sessionId, newSecondsUsed, recordedCreditsUsed);
    if (updateResult.error) {
      throw updateResult.error;
    }

    return res.json({
      recordedSeconds: secondsToRecord,
      totalBillableSeconds: newSecondsUsed,
      remainingCredits,
      shouldStop: remainingCredits <= 0,
    });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
