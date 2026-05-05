// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../server/supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../shared/backend-logger.js';

const CREDITS_PER_SECOND = 2;

function getDecartApiKey() {
  return process.env.DECART_API_KEY?.trim() || null;
}

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ allowed: false, error: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    const decartApiKey = getDecartApiKey();
    if (!decartApiKey) {
      return res.status(503).json({ allowed: false, error: 'Missing DECART_API_KEY in server environment' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ allowed: false, error: 'User ID is required' });

    await logRequestEvent('start-session.request', {
      method: req.method,
      path: '/api/start-session',
      userId,
    });

    // Fetch orphaned sessions and wallet in parallel
    const [activeSessionsResult, walletResult] = await Promise.all([
      supabaseAdmin.from('sessions').select('id, seconds_used, cost').eq('user_id', userId).eq('status', 'active'),
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
    ]);

    if (activeSessionsResult.error) {
      console.error('Failed to load active sessions:', activeSessionsResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load active sessions' });
    }

    if (walletResult.error) {
      console.error('Failed to load wallet:', walletResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load wallet' });
    }

    const existingActiveSessions = activeSessionsResult.data ?? [];
    const walletNow = walletResult.data;

    // Close any leftover active sessions without retroactively re-billing wall time.
    // If a session was already accruing tracked usage, preserve that recorded cost.
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      const cleanupResults = await Promise.all(
        existingActiveSessions.map(session =>
          supabaseAdmin.from('sessions')
            .update({
              end_time: new Date(),
              status: 'ended',
              seconds_used: normalizeSecondsUsed(session.seconds_used),
              cost: normalizeRecordedCost(session),
            })
            .eq('id', session.id)
            .eq('status', 'active'),
        ),
      );

      const cleanupError = cleanupResults.find(result => result?.error);
      if (cleanupError?.error) {
        console.error('Failed to close orphaned sessions:', cleanupError.error);
        return res.status(500).json({ allowed: false, error: 'Failed to close previous sessions' });
      }

      await logRequestEvent('start-session.stale_sessions_closed', {
        userId,
        count: existingActiveSessions.length,
      });
    }

    const userCredits = normalizeCredits(walletNow?.credits);
    if (userCredits <= 0) {
      await logRequestEvent('start-session.insufficient_credits', {
        userId,
        credits: userCredits,
      });
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    // Declare maxSeconds BEFORE the insert so it is stored correctly in the DB.
    // (Previously it was declared after the insert, causing max_seconds = NULL
    //  which made closeActiveSession fall back to wiping the entire balance.)
    const maxSeconds = Math.floor(userCredits / CREDITS_PER_SECOND);

    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,
        status: 'active',
        start_time: new Date(),
        cost: 0,
        seconds_used: 0,
      }).select('id').single();

    if (sessionError) {
      console.error('Failed to create session:', sessionError);
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    await logRequestEvent('start-session.started', {
      userId,
      sessionId: newSession.id,
      credits: userCredits,
      maxSeconds,
    });

    res.json({ allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds, token: decartApiKey });
  } catch (error) {
    console.error('start-session unexpected error:', error);
    await logErrorEvent('start-session.exception', error);
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}
