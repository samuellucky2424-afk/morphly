// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

const CREDITS_PER_SECOND = 2;
const DECART_API_BASE_URL = 'https://api.decart.ai';
const DECART_REALTIME_MODEL = 'lucy-2.5';
const CLIENT_TOKEN_TTL_SECONDS = 300;

function getDecartApiKey() {
  return process.env.DECART_API_KEY?.trim() || null;
}

function getRealtimeBaseUrl() {
  return process.env.DECART_REALTIME_BASE_URL?.trim() || 'wss://api3.decart.ai';
}

async function createDecartClientToken(apiKey, userId, maxSeconds) {
  const providerResponse = await fetch(`${DECART_API_BASE_URL}/v1/client/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({
      expiresIn: CLIENT_TOKEN_TTL_SECONDS,
      allowedModels: [DECART_REALTIME_MODEL],
      constraints: { realtime: { maxSessionDuration: Math.min(maxSeconds, 7200) } },
      metadata: { userId },
    }),
  });
  const providerData = await providerResponse.json().catch(() => ({}));

  console.log('[AI_SESSION]', {
    providerStatus: providerResponse.status,
    hasToken: Boolean(providerData.apiKey),
    expiresAt: providerData.expiresAt ?? null,
    providerError: providerData.error ?? null,
  });

  if (!providerResponse.ok || !providerData.apiKey) {
    return { error: {
      error: 'AI_SESSION_CREATION_FAILED',
      providerStatus: providerResponse.status,
      details: providerData?.error || providerData?.message || 'Unknown provider error',
    } };
  }

  return { token: providerData.apiKey, expiresAt: providerData.expiresAt ?? null };
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
  const cost = Number(session?.cost ?? session?.credits_used ?? 0);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || error?.details || '');
  return error?.code === 'PGRST204' || new RegExp(`\\b${columnName}\\b`, 'i').test(message);
}

async function selectActiveSessions(userId) {
  const withCost = await supabaseAdmin
    .from('sessions')
    .select('id, seconds_used, cost')
    .eq('user_id', userId)
    .eq('status', 'active');

  if (!isMissingColumnError(withCost.error, 'cost')) {
    return withCost;
  }

  return supabaseAdmin
    .from('sessions')
    .select('id, seconds_used, credits_used')
    .eq('user_id', userId)
    .eq('status', 'active');
}

async function closeExistingSession(session) {
  const baseUpdate = {
    end_time: new Date(),
    status: 'ended',
    seconds_used: normalizeSecondsUsed(session.seconds_used),
  };
  const recordedCost = normalizeRecordedCost(session);

  const withCost = await supabaseAdmin.from('sessions')
    .update({ ...baseUpdate, cost: recordedCost })
    .eq('id', session.id)
    .eq('status', 'active');

  if (!isMissingColumnError(withCost.error, 'cost')) {
    return withCost;
  }

  return supabaseAdmin.from('sessions')
    .update({ ...baseUpdate, credits_used: recordedCost })
    .eq('id', session.id)
    .eq('status', 'active');
}

async function createActiveSession(userId) {
  const baseInsert = {
    user_id: userId,
    status: 'active',
    start_time: new Date(),
    seconds_used: 0,
  };

  const withCost = await supabaseAdmin
    .from('sessions')
    .insert({ ...baseInsert, cost: 0 })
    .select('id')
    .single();

  if (!isMissingColumnError(withCost.error, 'cost')) {
    return withCost;
  }

  return supabaseAdmin
    .from('sessions')
    .insert({ ...baseInsert, credits_used: 0 })
    .select('id')
    .single();
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

    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ allowed: false, error: authResult.error });
    const userId = authResult.user.id;
    if (req.body?.userId && req.body.userId !== userId) return res.status(403).json({ allowed: false, error: 'User mismatch' });

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('users').select('account_status').eq('id', userId).maybeSingle();
    if (profileError) throw profileError;
    if (profile?.account_status === 'suspended') {
      return res.status(403).json({ allowed: false, error: 'Account suspended' });
    }

    await logRequestEvent('start-session.request', {
      method: req.method,
      path: '/api/start-session',
      userId,
    });

    // Fetch orphaned sessions and wallet in parallel
    const [activeSessionsResult, walletResult] = await Promise.all([
      selectActiveSessions(userId),
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
        existingActiveSessions.map(closeExistingSession),
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
    if (userCredits < CREDITS_PER_SECOND) {
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

    // Mint a short-lived client token. Never expose or log the account API key.
    const providerSession = await createDecartClientToken(decartApiKey, userId, maxSeconds);
    if (providerSession.error) {
      return res.status(502).json({ allowed: false, ...providerSession.error });
    }

    const { data: newSession, error: sessionError } = await createActiveSession(userId);

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

    res.json({
      allowed: true,
      sessionId: newSession.id,
      credits: userCredits,
      maxSeconds,
      token: providerSession.token,
      expiresAt: providerSession.expiresAt,
      websocketUrl: getRealtimeBaseUrl(),
      model: DECART_REALTIME_MODEL,
    });
  } catch (error) {
    console.error('start-session unexpected error:', error);
    await logErrorEvent('start-session.exception', error);
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}
