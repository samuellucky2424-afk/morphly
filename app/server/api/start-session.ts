// @ts-nocheck
import { isLocalPreviewRequest } from '../local-preview.js';
import crypto from 'crypto';
import { sessionStartLimit } from '../session-start-limit.js';
import { createDecartTemporaryKey as createScopedDecartKey } from '../decart-token.js';
import { realtimeWalletBalance } from '../realtime-billing.js';
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

const CREDITS_PER_SECOND = 2;
const DECART_DEFAULT_API_BASE_URL = 'https://api.decart.ai';
const DECART_REALTIME_MODEL = 'lucy-2.5';
const VIDU_REALTIME_MODEL = 's2-editing';
const VIDU_DEFAULT_API_BASE_URL = 'https://api.vidu.com';
const DEFAULT_REALTIME_PROVIDER = 'vidu';
const TEMPORARY_KEY_GRACE_SECONDS = 120;
const DEFAULT_PROVIDER_SESSION_LIMIT_SECONDS = 1800;
const DEFAULT_UNVERIFIED_WALLET_LIMIT = 5000;
const TOKEN_MINT_WINDOW_MINUTES = 10;
const TOKEN_MINT_LIMIT_PER_WINDOW = 30;
const VIDU_TOKEN_MAX_ATTEMPTS = 2;
const VIDU_TOKEN_RETRY_DELAY_MS = 600;

function getDecartApiKey() {
  return process.env.DECART_API_KEY?.trim() || null;
}

function getViduApiKey() {
  return process.env.VIDU_API_KEY?.trim() || null;
}

function getViduApiBaseUrl() {
  return (process.env.VIDU_API_BASE_URL?.trim() || VIDU_DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

export function normalizeRealtimeProvider(value) {
  return value === 'decart' ? 'decart' : DEFAULT_REALTIME_PROVIDER;
}

function getProviderModel(provider) {
  return provider === 'decart' ? DECART_REALTIME_MODEL : VIDU_REALTIME_MODEL;
}

function getProviderApiKey(provider) {
  return provider === 'decart' ? getDecartApiKey() : getViduApiKey();
}

function getProviderPublicLabel(provider) {
  return provider === 'decart' ? 'Pro' : 'Plus';
}

function getProviderSessionLimitSeconds(provider) {
  const configured = Number(provider === 'decart' ? process.env.DECART_MAX_SESSION_SECONDS : process.env.VIDU_MAX_SESSION_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_PROVIDER_SESSION_LIMIT_SECONDS;
  return Math.min(7200, Math.max(10, Math.floor(configured)));
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

export async function createDecartTemporaryKey({ apiKey, maxSeconds, allowedOrigins = [], userId, sessionId, installationId }) {
  const sessionLimit = Math.max(1, Math.min(Math.floor(Number(maxSeconds) || 1), 7200));
  // Decart enforces a minimum ten-second duration. Never mint a token whose
  // minimum provider allowance exceeds the account's affordable duration.
  if (sessionLimit < 10) return { error: { error: 'INSUFFICIENT_CREDITS', details: 'Pro requires at least 25 credits to start a session.' } };
  try {
    const response = await fetch(`${DECART_DEFAULT_API_BASE_URL}/v1/client/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({
        expiresIn: 60,
        allowedModels: [DECART_REALTIME_MODEL],
        ...(allowedOrigins.length ? { allowedOrigins } : {}),
        constraints: { realtime: { maxSessionDuration: sessionLimit } },
        metadata: { userId, sessionId, installationId },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.apiKey !== 'string' || !data.apiKey || data.apiKey === apiKey) {
      return { error: { error: 'AI_SESSION_CREATION_FAILED', providerStatus: response.status, details: 'Pro could not create a secure session. Check Decart access or try again.' } };
    }
    return { token: data.apiKey, expiresAt: data.expiresAt, sessionLimit };
  } catch {
    return { error: { error: 'AI_SESSION_CREATION_FAILED', details: 'Pro could not be reached. Please try again.' } };
  }
}

export async function createViduTemporaryKey({
  apiKey,
  maxSeconds,
  userId,
  sessionId,
  installationId,
  imageUrl,
}) {
  const sessionLimit = Math.max(1, Math.min(Math.floor(Number(maxSeconds) || 1), 120));
  const baseUrl = getViduApiBaseUrl();

  if (process.env.NODE_ENV === 'development' && !process.env.VERCEL && (process.env.VIDU_MOCK === 'true' || apiKey === 'mock')) {
    return {
      token: `mock_vidu_secret_${sessionId}`,
      liveId: `mock_live_${Date.now()}`,
      renderUid: `mock_render_${sessionId}`,
      sessionLimit,
      expiresAt: new Date(Date.now() + sessionLimit * 1000).toISOString(),
    };
  }

  const effectiveImageUrl = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  if (!/^(https?:\/\/|data:image\/(png|jpeg|webp);base64,|ssupload:)/i.test(effectiveImageUrl) || effectiveImageUrl.length > 3_000_000) {
    return { error: { error: 'INVALID_REFERENCE_IMAGE', details: 'Choose a reference image under 2 MB for Plus.' } };
  }

  for (let attempt = 1; attempt <= VIDU_TOKEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/live/s_editing/realtime`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: apiKey,
        },
        body: JSON.stringify({
          image_url: effectiveImageUrl,
          editing_type: 'subject_replacement',
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const providerStatus = response.status;
        const providerCode = data?.code || data?.error_code || null;
        const message = data?.message || data?.error || response.statusText;
        const retryable = providerStatus === 429;
        const unavailable = providerStatus >= 500;

        console.warn('[Vidu] realtime session request failed', {
          attempt,
          providerStatus,
          providerCode,
          message,
          retryable,
        });

        if (retryable && attempt < VIDU_TOKEN_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, VIDU_TOKEN_RETRY_DELAY_MS));
          continue;
        }

        const details = providerStatus === 401 || providerStatus === 403
          ? 'Plus could not authenticate this session. Check VIDU_API_KEY or contact support.'
          : providerStatus === 429
            ? 'Plus is limiting new sessions right now. Wait a moment, then try again.'
            : retryable || unavailable
              ? 'Plus is temporarily unavailable. Check your connection, then try again.'
              : 'Plus rejected this session configuration. Try Pro or contact support.';

        return {
          error: {
            error: 'AI_SESSION_CREATION_FAILED',
            providerStatus,
            providerCode,
            details,
          },
        };
      }

      const liveId = String(data?.live?.id || data?.live_id || data?.data?.live_id || '');
      const clientSecret = String(data?.client_secret || data?.data?.client_secret || '');
      if (!clientSecret || clientSecret === apiKey) {
        return { error: {
          error: 'VIDU_CLIENT_CREDENTIAL_MISSING',
          details: 'Vidu did not return browser session credentials. Check S2-Editing access for this API key.',
        } };
      }
      const renderUid = String(data?.render_uid || data?.data?.render_uid || '');
      const rtc = data?.rtc || data?.data?.rtc || null;
      if (!liveId || !renderUid || typeof rtc?.token !== 'string' || !rtc.token || rtc.token === apiKey || !rtc.user_id) {
        return { error: { error: 'VIDU_RTC_CREDENTIAL_MISSING', details: 'Vidu returned incomplete RTC connection details.' } };
      }
      const expiresAt = data?.expires_at || data?.data?.expires_at || new Date(Date.now() + sessionLimit * 1000).toISOString();

      return {
        token: clientSecret,
        liveId,
        traceId: typeof data?.live?.trace_id === 'string' ? data.live.trace_id : undefined,
        renderUid,
        rtc,
        expiresAt,
        sessionLimit: Math.min(sessionLimit, Number(data?.live?.live_duration) || sessionLimit),
        baseUrl,
      };
    } catch (error) {
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      console.warn('[Vidu] request exception:', error?.message);

      return {
        error: {
          error: 'AI_SESSION_CREATION_FAILED',
          providerStatus: isTimeout ? 408 : null,
          providerCode: isTimeout ? 'TIMEOUT' : null,
          details: 'Plus is temporarily unavailable. Check your connection, then try again.',
        },
      };
    }
  }

  return {
    error: {
      error: 'AI_SESSION_CREATION_FAILED',
      providerStatus: null,
      providerCode: null,
      details: 'Plus is temporarily unavailable. Check your connection, then try again.',
    },
  };
}

async function createProviderTemporaryCredential({
  provider,
  apiKey,
  maxSeconds,
  allowedOrigins,
  userId,
  sessionId,
  installationId,
  imageUrl,
}) {
  if (provider === 'decart') return createScopedDecartKey({apiKey,maxSeconds,allowedOrigins,userId,sessionId});
  if (provider === 'vidu' || provider === 'decart') {
    return createViduTemporaryKey({
      apiKey,
      maxSeconds,
      userId,
      sessionId,
      installationId,
      imageUrl,
    });
  }

  return createDecartTemporaryKey({ apiKey, maxSeconds, allowedOrigins, userId, sessionId, installationId });
}

function isMissingFunctionError(error, functionName) {
  const message = String(error?.message || error?.details || error?.hint || '');
  return ['PGRST202', '42883'].includes(error?.code) ||
    new RegExp(`${functionName}|schema cache|function .* does not exist`, 'i').test(message);
}

async function recordProviderTokenAudit({
  provider,
  model,
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
    event_name: status === 'issued'
      ? `${provider}_token_issued`
      : `${provider}_token_failed`,
    metadata: {
      provider,
      model,
      maxSessionSeconds: maxSeconds,
      expiresAt,
      requestFingerprint,
      providerStatus: providerStatus ?? null,
      source: 'server',
    },
  });

  if (error) {
    console.warn(`Failed to persist ${provider} credential audit event:`, error.message || error.code);
  }
}

async function getRecentTokenMintCount(userId) {
  const since = new Date(Date.now() - TOKEN_MINT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const result = await supabaseAdmin.from('analytics_events').select('created_at')
    .eq('user_id', userId).in('event_name', ['xmax_key_issued', 'vidu_token_issued', 'decart_token_issued']).gte('created_at', since);
  if (result.error) throw result.error;
  return sessionStartLimit(result.data || []);
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
  const requestStartedAt = Date.now();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const isLocalPreview = isLocalPreviewRequest(req);

    if (req.body?.provider !== 'vidu') {
      return res.status(400).json({ allowed: false, error: 'Only Plus subject replacement is available. Update Morphly and try again.' });
    }

    const provider = normalizeRealtimeProvider(req.body?.provider);
    const minimumCreditRate = provider === 'decart' ? 2.5 : CREDITS_PER_SECOND;
    const providerModel = getProviderModel(provider);
    const providerApiKey = getProviderApiKey(provider);

    if (isLocalPreview) {
      const sessionId = `preview_session_${Date.now()}`;
      const effectiveApiKey = (providerApiKey && !providerApiKey.includes('your_')) ? providerApiKey : 'mock';
      const providerSession = await createProviderTemporaryCredential({
        provider,
        apiKey: effectiveApiKey,
        maxSeconds: 1800,
        allowedOrigins: getBrowserTokenOrigins(req, req.body?.platform),
        userId: req.body?.userId || '00000000-0000-0000-0000-000000000001',
        sessionId,
        installationId: 'local_preview',
        imageUrl: req.body?.imageUrl || req.body?.image_url || req.body?.referenceImage,
      });

      if (providerSession.error) {
        return res.status(502).json({ allowed: false, ...providerSession.error });
      }
      return res.json({
        allowed: true,
        sessionId,
        credits: 999999,
        maxSeconds: providerSession.sessionLimit || 1800,
        baseUrl: providerSession.baseUrl,
        token: providerSession.token,
        liveId: providerSession.liveId || `preview_live_${Date.now()}`,
        renderUid: providerSession.renderUid || `preview_render_${Date.now()}`,
        rtc: providerSession.rtc || null,
        expiresAt: providerSession.expiresAt || new Date(Date.now() + 1800 * 1000).toISOString(),
        provider,
        model: providerModel,
        startupTimings: { totalMs: Date.now() - requestStartedAt },
      });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({ allowed: false, error: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    if (!providerApiKey) {
      const environmentName = provider === 'decart' ? 'DECART_API_KEY' : 'VIDU_API_KEY';
      return res.status(503).json({
        allowed: false,
        error: `${getProviderPublicLabel(provider)} is not configured on this server.`,
        details: `Missing ${environmentName} in server environment`,
      });
    }

    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ allowed: false, error: authResult.error });
    const authorizationMs = Date.now() - requestStartedAt;
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

    // Fire-and-forget: request logging must not delay session startup.
    void logRequestEvent('start-session.request', {
      method: req.method,
      path: '/api/start-session',
      userId,
      provider,
      model: providerModel,
    });

    const validationStartedAt = Date.now();
    // Independent account, wallet, stale-session, and rate-limit checks share one
    // network round trip instead of delaying startup in a serial chain.
    const [profileResult, activeSessionsResult, walletResult, recentTokenMints] = await Promise.all([
      supabaseAdmin.from('users').select('account_status').eq('id', userId).maybeSingle(),
      selectActiveSessions(userId),
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
      getRecentTokenMintCount(userId),
    ]);

    if (profileResult.error) throw profileResult.error;
    if (profileResult.data?.account_status === 'suspended') {
      return res.status(403).json({ allowed: false, error: 'Account suspended' });
    }

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

    userCredits = await realtimeWalletBalance(supabaseAdmin, userId, userCredits);
    if (userCredits < (provider === 'decart' ? 25 : minimumCreditRate)) {
      await logRequestEvent('start-session.insufficient_credits', {
        userId,
        credits: userCredits,
      });
      return res.json({ allowed: false, error: provider === 'decart' ? 'Pro requires at least 25 credits to start (2.5 cr/sec).' : 'Insufficient credits' });
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

    if (recentTokenMints.retryAfterSeconds > 0) {
      await logRequestEvent('start-session.rate_limited', {
        userId,
        recentTokenMints: recentTokenMints.count,
        windowMinutes: TOKEN_MINT_WINDOW_MINUTES,
      });
      res.setHeader('Retry-After', String(recentTokenMints.retryAfterSeconds));
      return res.status(429).json({
        allowed: false,
        code: 'SESSION_START_RATE_LIMIT',
        retryAfterSeconds: recentTokenMints.retryAfterSeconds,
        error: `Too many recent connection attempts. Retry in ${recentTokenMints.retryAfterSeconds} seconds. This is Morphly's retry limit, not an AI capacity error.`,
      });
    }

    const validationMs = Date.now() - validationStartedAt;
    const requestFingerprint = getRequestFingerprint(req);
    const maxSeconds = Math.min(
      Math.floor(userCredits / minimumCreditRate),
      getProviderSessionLimitSeconds(provider),
    );

    // Create the Morphly session first so temporary-key issuance can be attributed
    // to the exact internal session ID. Never expose or log the permanent API key.
    const sessionRecordStartedAt = Date.now();
    const { data: newSession, error: sessionError } = await createActiveSession(userId);
    const sessionRecordMs = Date.now() - sessionRecordStartedAt;

    if (sessionError) {
      console.error('Failed to create session:', sessionError);
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    // New clients require timestamp billing; never silently use a legacy rate.
    const billingSetup = await supabaseAdmin.rpc('configure_realtime_video', {
      p_user: userId, p_session: newSession.id, p_rate_half: provider === 'decart' ? 5 : 4,
    });
    if (billingSetup.error) {
      await closeExistingSession({ id: newSession.id, seconds_used: 0, cost: 0 });
      console.error('Realtime billing setup failed; check database migrations:', billingSetup.error.code);
      return res.status(503).json({ allowed: false, error: 'Realtime billing is temporarily unavailable. Please try again later.' });
    }
    const billingVersion = 2;
    const { error: providerAuditError } = await supabaseAdmin.from('sessions').update({
      provider, provider_model: providerModel, provider_max_seconds: maxSeconds,
    }).eq('id', newSession.id);
    if (providerAuditError) {
      await closeExistingSession({ id: newSession.id, seconds_used: 0, cost: 0 });
      throw providerAuditError;
    }
    const providerCredentialStartedAt = Date.now();
    const providerSession = await createProviderTemporaryCredential({
      provider,
      apiKey: providerApiKey,
      maxSeconds,
      allowedOrigins,
      userId,
      sessionId: newSession.id,
      installationId,
      imageUrl: req.body?.imageUrl || req.body?.image_url || req.body?.referenceImage,
    });
    const providerCredentialMs = Date.now() - providerCredentialStartedAt;
    if (providerSession.error) {
      await recordProviderTokenAudit({
        provider,
        model: providerModel,
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

    const auditStartedAt = Date.now();
    if (supabaseAdmin.provider === 'firebase') {
      const saved = await supabaseAdmin.from('sessions').update({provider,provider_max_seconds:providerSession.sessionLimit || maxSeconds}).eq('id',newSession.id);
      if (saved.error) throw saved.error;
    }
    // Provider attribution lives in analytics_events. The optional provider
    // columns are absent from older session schemas and must not block startup.
    await recordProviderTokenAudit({
      provider,
      model: providerModel,
      userId,
      sessionId: newSession.id,
      installationId,
      platform,
      expiresAt: providerSession.expiresAt,
      maxSeconds,
      requestFingerprint,
      status: 'issued',
    });
    const auditMs = Date.now() - auditStartedAt;
    const startupTimings = {
      totalMs: Date.now() - requestStartedAt,
      authorizationMs,
      validationMs,
      sessionRecordMs,
      providerCredentialMs,
      auditMs,
    };

    // Fire-and-forget: the startup audit log must not delay the token response.
    void logRequestEvent('start-session.started', {
      userId,
      sessionId: newSession.id,
      credits: userCredits,
      maxSeconds,
      installationId,
      requestFingerprint,
      provider,
      model: providerModel,
      startupTimings,
    });

    res.setHeader(
      'Server-Timing',
      `auth;dur=${authorizationMs}, validation;dur=${validationMs}, session;dur=${sessionRecordMs}, ` +
      `credential;dur=${providerCredentialMs}, audit;dur=${auditMs}`,
    );

    res.json({
      allowed: true,
      sessionId: newSession.id,
      credits: userCredits,
      billingVersion,
      serverNow: Date.now(),
      maxSeconds: providerSession.sessionLimit || maxSeconds,
      baseUrl: providerSession.baseUrl,
      token: providerSession.token,
      liveId: providerSession.liveId,
      traceId: providerSession.traceId,
      renderUid: providerSession.renderUid,
      rtc: providerSession.rtc,
      expiresAt: providerSession.expiresAt,
      provider,
      model: providerModel,
      startupTimings,
    });
  } catch (error) {
    console.error('start-session unexpected error:', error);
    await logErrorEvent('start-session.exception', error);
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}
