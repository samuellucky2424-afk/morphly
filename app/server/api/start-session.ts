// @ts-nocheck
import crypto from 'crypto';
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

const CREDITS_PER_SECOND = 2;
const DECART_API_BASE_URL = 'https://api.decart.ai';
const DECART_REALTIME_MODEL = 'lucy-2.5';
const CLIENT_TOKEN_TTL_SECONDS = 300;
const DEFAULT_PROVIDER_SESSION_LIMIT_SECONDS = 1800;
const DEFAULT_UNVERIFIED_WALLET_LIMIT = 5000;
const TOKEN_MINT_WINDOW_MINUTES = 10;
const TOKEN_MINT_LIMIT_PER_WINDOW = 6;

function getDecartApiKey() {
  return process.env.DECART_API_KEY?.trim() || null;
}

function getRealtimeBaseUrl() {
  return process.env.DECART_REALTIME_BASE_URL?.trim() || 'wss://api3.decart.ai';
}

function getProviderSessionLimitSeconds() {
  const configured = Number(process.env.DECART_MAX_SESSION_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_PROVIDER_SESSION_LIMIT_SECONDS;
  return Math.min(7200, Math.max(60, Math.floor(configured)));
}

function getUnverifiedWalletLimit() {
  const configured = Number(process.env.MAX_UNVERIFIED_WALLET_CREDITS);
  if (!Number.isFinite(configured)) return DEFAULT_UNVERIFIED_WALLET_LIMIT;
  return Math.max(5000, Math.floor(configured));
}

function normalizeClientLabel(value, maxLength = 120) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) || null : null;
}

function getRequestFingerprint(req) {
  const forwardedFor = normalizeClientLabel(req.headers?.['x-forwarded-for'], 200) || '';
  const userAgent = normalizeClientLabel(req.headers?.['user-agent'], 300) || '';
  if (!forwardedFor && !userAgent) return null;
  return crypto.createHash('sha256').update(`${forwardedFor}|${userAgent}`).digest('hex').slice(0, 20);
}

export function getBrowserTokenOrigins(req, platform) {
  if (platform !== 'web') return [];

  const originHeader = normalizeClientLabel(req.headers?.origin, 253);
  if (!originHeader) return [];

  try {
    const originUrl = new URL(originHeader);
    if (!['http:', 'https:'].includes(originUrl.protocol)) return [];
    if (originUrl.origin !== originHeader.toLowerCase()) return [];
    return [originUrl.origin];
  } catch {
    return [];
  }
}

async function createDecartClientToken(
  apiKey,
  userId,
  sessionId,
  maxSeconds,
  installationId,
  allowedOrigins,
) {
  const safeMaxSeconds = Math.max(60, Math.min(Math.floor(Number(maxSeconds) || 1800), 7200));
  const tokenPayload = {
    expiresIn: CLIENT_TOKEN_TTL_SECONDS,
    allowedModels: [DECART_REALTIME_MODEL],
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    constraints: { realtime: { maxSessionDuration: safeMaxSeconds } },
    metadata: {
      morphlyUserId: userId,
      morphlySessionId: sessionId,
      ...(installationId ? { morphlyInstallationId: installationId } : {}),
    },
  };

  let providerResponse;
  try {
    providerResponse = await fetch(`${DECART_API_BASE_URL}/v1/client/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify(tokenPayload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { error: {
      error: 'AI_SESSION_CREATION_FAILED',
      providerStatus: null,
      details: timedOut
        ? 'Decart did not respond in time. Please try again.'
        : 'Decart could not be reached. Check the connection and try again.',
    } };
  }
  const providerData = await providerResponse.json().catch(() => ({}));

  console.log('[AI_SESSION]', {
    providerStatus: providerResponse.status,
    hasToken: Boolean(providerData.apiKey),
    expiresAt: providerData.expiresAt ?? null,
    providerError: providerData.error ?? null,
  });

  if (!providerResponse.ok || !providerData.apiKey) {
    const errorDetails = typeof providerData?.error === 'string'
      ? providerData.error
      : providerData?.message || providerData?.error?.message || 'Unknown provider error';
    return { error: {
      error: 'AI_SESSION_CREATION_FAILED',
      providerStatus: providerResponse.status,
      details: errorDetails,
    } };
  }

  return { token: providerData.apiKey, expiresAt: providerData.expiresAt ?? null };
}

function isMissingFunctionError(error, functionName) {
  const message = String(error?.message || error?.details || error?.hint || '');
  return ['PGRST202', '42883'].includes(error?.code) ||
    new RegExp(`${functionName}|schema cache|function .* does not exist`, 'i').test(message);
}

async function recordProviderTokenAudit({
  userId,
  sessionId,
  installationId,
  platform,
  expiresAt,
  maxSeconds,
  requestFingerprint,
  status,
  providerStatus,
}) {
  const { error } = await supabaseAdmin.from('analytics_events').insert({
    user_id: userId,
    installation_id: installationId,
    session_id: sessionId,
    platform,
    event_name: status === 'issued' ? 'decart_token_issued' : 'decart_token_failed',
    metadata: {
      provider: 'decart',
      model: DECART_REALTIME_MODEL,
      tokenTtlSeconds: CLIENT_TOKEN_TTL_SECONDS,
      maxSessionSeconds: maxSeconds,
      expiresAt,
      requestFingerprint,
      providerStatus: providerStatus ?? null,
      source: 'server',
    },
  });

  if (error) {
    console.warn('Failed to persist Decart token audit event:', error.message || error.code);
  }
}

async function updateSessionProviderAudit(sessionId, values) {
  const { error } = await supabaseAdmin.from('sessions').update(values).eq('id', sessionId);
  if (error && !/PGRST204|provider_|client_installation_id|schema cache/i.test(
    String(error.message || error.details || error.code || ''),
  )) {
    throw error;
  }
}

async function getRecentTokenMintCount(userId) {
  const since = new Date(Date.now() - TOKEN_MINT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const [sessionCountResult, eventCountResult] = await Promise.all([
    supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).gte('created_at', since),
    supabaseAdmin.from('analytics_events').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('event_name', 'decart_token_issued').gte('created_at', since),
  ]);

  if (sessionCountResult.error) throw sessionCountResult.error;
  if (eventCountResult.error) {
    console.warn('Unable to read token audit rate limit:', eventCountResult.error.message);
  }
  return Math.max(sessionCountResult.count || 0, eventCountResult.count || 0);
}

async function hasWalletCreditProvenance(userId) {
  const [transactionResult, ledgerResult, adminResult] = await Promise.all([
    supabaseAdmin.from('transactions')
      .select('id, type, transaction_type, status, amount, amount_naira, credits, package_credits_snapshot, reference')
      .eq('user_id', userId).limit(100),
    supabaseAdmin.from('wallet_ledger').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).gt('delta', 0),
    supabaseAdmin.from('admin_users').select('user_id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('is_active', true),
  ]);

  if (transactionResult.error) throw transactionResult.error;
  if (ledgerResult.error && !/42P01|PGRST205|does not exist|schema cache/i.test(
    String(ledgerResult.error.message || ledgerResult.error.code || ''),
  )) {
    throw ledgerResult.error;
  }
  if (adminResult.error) throw adminResult.error;

  const hasVerifiedGrant = (transactionResult.data || []).some((transaction) => {
    const type = String(transaction.transaction_type || transaction.type || '').toLowerCase();
    const status = String(transaction.status || '').toLowerCase();
    const reference = String(transaction.reference || '').toLowerCase();
    const amount = Number(transaction.amount_naira ?? transaction.amount ?? 0);
    const credits = Number(transaction.credits ?? transaction.package_credits_snapshot ?? 0);
    const acceptedStatus = !status || ['success', 'successful', 'succeeded', 'completed', 'paid', 'verified'].includes(status);
    const isPaidPurchase = ['credit', 'credit_purchase', 'purchase', 'payment'].includes(type)
      && acceptedStatus
      && Number.isFinite(amount)
      && amount > 0;
    const isTrustedGrant = acceptedStatus
      && Number.isFinite(credits)
      && credits > 0
      && /^(admin:|signup_bonus:|referral_reward:|morphly_)/.test(reference);
    return isPaidPurchase || isTrustedGrant;
  });

  return hasVerifiedGrant
    || (ledgerResult.count || 0) > 0
    || (adminResult.count || 0) > 0;
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

async function finalizeExistingSession(session, userId) {
  const rpcResult = await supabaseAdmin.rpc('finalize_ai_session', {
    p_user: userId,
    p_session: session.id,
    p_final_seconds_delta: 0,
    p_reason: 'superseded',
  });

  if (!rpcResult.error) return rpcResult;
  if (!isMissingFunctionError(rpcResult.error, 'finalize_ai_session')) {
    return rpcResult;
  }
  return closeExistingSession(session);
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
    const installationId = normalizeClientLabel(req.body?.installationId, 120);
    const platform = normalizeClientLabel(req.body?.platform, 30);
    const allowedOrigins = getBrowserTokenOrigins(req, platform);
    if (platform === 'web' && allowedOrigins.length === 0) {
      return res.status(400).json({
        allowed: false,
        error: 'A canonical browser origin is required to start an AI session.',
      });
    }

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

    // Close any leftover active sessions. The new SQL RPC atomically applies
    // recorded-but-not-yet-debited usage before closing; the legacy fallback
    // preserves the previous deployment behavior until the migration exists.
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      const cleanupResults = await Promise.all(
        existingActiveSessions.map(session => finalizeExistingSession(session, userId)),
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

    let userCredits = normalizeCredits(walletNow?.credits);
    if (existingActiveSessions.length > 0) {
      const refreshedWallet = await supabaseAdmin
        .from('wallets').select('credits').eq('user_id', userId).maybeSingle();
      if (refreshedWallet.error) throw refreshedWallet.error;
      userCredits = normalizeCredits(refreshedWallet.data?.credits);
    }

    if (userCredits < CREDITS_PER_SECOND) {
      await logRequestEvent('start-session.insufficient_credits', {
        userId,
        credits: userCredits,
      });
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    const unverifiedWalletLimit = getUnverifiedWalletLimit();
    if (
      userCredits > unverifiedWalletLimit
      && !(await hasWalletCreditProvenance(userId))
    ) {
      await logRequestEvent('start-session.unverified_wallet_blocked', {
        userId,
        credits: userCredits,
        unverifiedWalletLimit,
      });
      return res.status(403).json({
        allowed: false,
        error: 'This wallet balance requires administrator review before AI usage can continue.',
      });
    }

    const recentTokenMints = await getRecentTokenMintCount(userId);
    if (recentTokenMints >= TOKEN_MINT_LIMIT_PER_WINDOW) {
      await logRequestEvent('start-session.rate_limited', {
        userId,
        recentTokenMints,
        windowMinutes: TOKEN_MINT_WINDOW_MINUTES,
      });
      return res.status(429).json({
        allowed: false,
        error: `Too many AI sessions. Try again in ${TOKEN_MINT_WINDOW_MINUTES} minutes.`,
      });
    }

    const requestFingerprint = getRequestFingerprint(req);
    const maxSeconds = Math.min(
      Math.floor(userCredits / CREDITS_PER_SECOND),
      getProviderSessionLimitSeconds(),
    );

    // Create the Morphly session first so the provider token can be tagged with
    // the exact internal session ID. Never expose or log the permanent API key.
    const { data: newSession, error: sessionError } = await createActiveSession(userId);

    if (sessionError) {
      console.error('Failed to create session:', sessionError);
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    await updateSessionProviderAudit(newSession.id, {
      provider: 'decart',
      provider_model: DECART_REALTIME_MODEL,
      provider_max_seconds: maxSeconds,
      client_installation_id: installationId,
    });

    const providerSession = await createDecartClientToken(
      decartApiKey,
      userId,
      newSession.id,
      maxSeconds,
      installationId,
      allowedOrigins,
    );
    if (providerSession.error) {
      await recordProviderTokenAudit({
        userId,
        sessionId: newSession.id,
        installationId,
        platform,
        expiresAt: null,
        maxSeconds,
        requestFingerprint,
        status: 'failed',
        providerStatus: providerSession.error.providerStatus,
      });
      await closeExistingSession({ id: newSession.id, seconds_used: 0, cost: 0 });
      return res.status(502).json({ allowed: false, ...providerSession.error });
    }

    await Promise.all([
      updateSessionProviderAudit(newSession.id, {
        provider_token_issued_at: new Date().toISOString(),
        provider_token_expires_at: providerSession.expiresAt,
      }),
      recordProviderTokenAudit({
        userId,
        sessionId: newSession.id,
        installationId,
        platform,
        expiresAt: providerSession.expiresAt,
        maxSeconds,
        requestFingerprint,
        status: 'issued',
      }),
    ]);

    await logRequestEvent('start-session.started', {
      userId,
      sessionId: newSession.id,
      credits: userCredits,
      maxSeconds,
      installationId,
      requestFingerprint,
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
