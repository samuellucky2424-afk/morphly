// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { logErrorEvent, logRequestEvent } from '../shared/backend-logger.js';

const CREDITS_PER_SECOND = 2;
// Hard ceiling: one session can never bill more than 2 hours,
// protecting users whose app crashed and left an orphaned session.
const MAX_BILLABLE_SECONDS = 7200;

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? credits : 0;
}

function normalizeSecondsUsed(value) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

function normalizeRecordedCost(session) {
  const cost = Number(session?.cost ?? 0);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function getBillableSeconds(startTime) {
  const timestamp = new Date(startTime).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  const elapsedSeconds = Math.floor((Date.now() - timestamp) / 1000);
  return Math.min(Math.max(elapsedSeconds, 0), MAX_BILLABLE_SECONDS);
}

// Bills the exact seconds streamed (start_time → now), capped at max_seconds.
async function billAndCloseSession(session, userId) {
  const { data: walletData, error: walletError } = await supabaseAdmin
    .from('wallets').select('credits').eq('user_id', userId).maybeSingle();

  if (walletError) {
    throw walletError;
  }

  const currentCredits = normalizeCredits(walletData?.credits);

  const billableSeconds = getBillableSeconds(session.start_time);
  const creditsToDeduct = Math.min(currentCredits, billableSeconds * CREDITS_PER_SECOND);
  const newCredits = currentCredits - creditsToDeduct;

  const updateResults = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(),
        status: 'ended',
        seconds_used: billableSeconds,
        cost: creditsToDeduct,
      })
      .eq('id', session.id)
      .eq('status', 'active'),
    creditsToDeduct > 0
      ? supabaseAdmin.from('wallets').update({ credits: newCredits }).eq('user_id', userId)
      : Promise.resolve(),
  ]);

  const updateError = updateResults.find(result => result?.error);
  if (updateError?.error) {
    throw updateError.error;
  }

  return newCredits;
}

async function closeStaleSession(session) {
  return supabaseAdmin
    .from('sessions')
    .update({
      end_time: new Date(),
      status: 'ended',
      seconds_used: normalizeSecondsUsed(session.seconds_used),
      cost: normalizeRecordedCost(session),
    })
    .eq('id', session.id)
    .eq('status', 'active');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ success: false, message: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    const { userId, sessionId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

    await logRequestEvent('end-session.request', {
      method: req.method,
      path: '/api/end-session',
      userId,
      sessionId,
    });

    const { data: activeSessions, error: activeSessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, start_time, seconds_used, cost')
      .eq('user_id', userId).eq('status', 'active')
      .order('created_at', { ascending: false });

    if (activeSessionError) {
      console.error('Failed to load active session:', activeSessionError);
      return res.status(500).json({ success: false, message: 'Failed to load active session' });
    }

    if (!activeSessions || activeSessions.length === 0) {
      await logRequestEvent('end-session.no_active_session', {
        userId,
        sessionId,
      });
      return res.json({ success: true, message: 'No active session', remainingCredits: null });
    }

    const targetSession = (sessionId
      ? activeSessions.find(session => session.id === sessionId)
      : null) || activeSessions[0];

    const staleSessions = activeSessions.filter(session => session.id !== targetSession.id);
    if (staleSessions.length > 0) {
      const staleResults = await Promise.all(staleSessions.map(closeStaleSession));
      const staleError = staleResults.find(result => result?.error);
      if (staleError?.error) {
        console.error('Failed to close stale active sessions:', staleError.error);
        return res.status(500).json({ success: false, message: 'Failed to close stale active sessions' });
      }

      await logRequestEvent('end-session.stale_sessions_closed', {
        userId,
        targetSessionId: targetSession.id,
        count: staleSessions.length,
      });
    }

    const remainingCredits = await billAndCloseSession(targetSession, userId);
    await logRequestEvent('end-session.closed', {
      userId,
      sessionId: targetSession.id,
      remainingCredits,
    });
    return res.json({ success: true, remainingCredits });
  } catch (error) {
    console.error('end-session unexpected error:', error);
    await logErrorEvent('end-session.exception', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
