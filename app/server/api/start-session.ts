// @ts-nocheck
import { isLocalPreviewRequest } from '../local-preview.js';
import crypto from 'crypto';
import { createDecartTemporaryKey as createScopedDecartKey } from '../decart-token.js';
import { realtimeWalletBalance } from '../realtime-billing.js';
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import { canonicalRelayOrigin, getViduDemoAudience, hasViduDemoProxySecret, isViduDemoProxyEnabled, issueViduDemoTicket } from '../vidu-demo-ticket.js';

const CREDITS_PER_SECOND = 2;
const VIDU_MIN_START_SECONDS = 15;
const DECART_DEFAULT_API_BASE_URL = 'https://api.decart.ai';
const DECART_REALTIME_MODEL = 'lucy-2.5';
const VIDU_REALTIME_MODEL = 's2-editing';
export const REFERENCE_IMAGE_REJECTED_MESSAGE = 'This reference photo was rejected by the Plus safety check. Please upload a different photo: one clear, well-lit adult face, not a celebrity or public figure, no nudity and no minors.';
const VIDU_DEFAULT_API_BASE_URL = 'https://api.vidu.com';
const DEFAULT_REALTIME_PROVIDER = 'vidu';
const TEMPORARY_KEY_GRACE_SECONDS = 120;
const DEFAULT_PROVIDER_SESSION_LIMIT_SECONDS = 1800;
const DEFAULT_UNVERIFIED_WALLET_LIMIT = 5000;
const VIDU_TOKEN_MAX_ATTEMPTS = 2;
const VIDU_TOKEN_RETRY_DELAY_MS = 600;

function getDecartApiKey() {
  return process.env.DECART_API_KEY?.trim() || null;
}

function getViduApiKey() {
  return process.env.VIDU_API_KEY?.trim() || null;
}

export function getViduApiBaseUrl(environment = process.env) {
  const configured = environment.VIDU_API_BASE_URL?.trim() || VIDU_DEFAULT_API_BASE_URL;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || !['api.vidu.com', 'api.vidu.cn'].includes(url.hostname)
      || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

const VIDU_CONFIG_ERROR = { error: 'AI_SESSION_CONFIG_INVALID', details: 'Plus is unavailable. Please contact Morphly support.' };

// Match the demo's local proxy while binding each connection to its Morphly
// account and deployment. Packaged Electron requests have an opaque Origin.
export function getViduDemoSessionContext(req, { environment = process.env, supabase = supabaseAdmin } = {}) {
  if (environment.VIDU_DEMO_PROXY !== 'true') return null;
  const audience = getViduDemoAudience(environment);
  if (!isViduDemoProxyEnabled(environment) || !hasViduDemoProxySecret(environment.VIDU_DEMO_PROXY_SECRET)
    || !supabase?.db || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]$/.test(audience)) {
    return { error: VIDU_CONFIG_ERROR };
  }
  // Older clients and HTTP local development do not advertise the relay.
  // Keep their scoped provider credential until they opt in, in every hosted
  // environment. Current HTTPS web and packaged desktop clients opt in below.
  if (req.body?.signalingTransport !== 'morphly-proxy-v1') return null;
  const desktop = req.body?.platform === 'desktop';
  // Desktop renderers send `null`, `file://`, or a localhost origin depending
  // on how they were built; bind all non-HTTPS desktop origins as `null`
  // (the relay applies the same canonicalization when redeeming the ticket).
  const origin = desktop ? canonicalRelayOrigin(req.headers?.origin) : req.headers?.origin;
  let relayOrigin;
  try {
    const destination = new URL(`https://${req.headers?.host || ''}`);
    if (destination.username || destination.password || destination.port || destination.pathname !== '/'
      || destination.search || destination.hash) throw new Error();
    relayOrigin = destination.origin;
    if (desktop) {
      // An HTTPS origin on a desktop request is a browser page claiming to be
      // the desktop app; accept it only for this deployment's own origin.
      if (origin !== 'null' && origin !== relayOrigin) throw new Error('Untrusted desktop origin');
    } else if (origin === 'null') {
      throw new Error('Null origin not allowed for web');
    } else if (origin) {
      const source = new URL(origin);
      if (source.protocol !== 'https:' || source.origin !== origin || source.origin !== relayOrigin) throw new Error();
    } else {
      throw new Error('Missing origin header');
    }
  } catch {
    return { error: { error: 'INVALID_BROWSER_ORIGIN', details: 'Open Morphly again to start Plus.' } };
  }
  return { secret: environment.VIDU_DEMO_PROXY_SECRET, audience, origin, relayOrigin,
    userAgent: normalizeClientLabel(req.headers?.['user-agent'], 512) || '' };
}

export function createViduDemoSignalingSession(providerSession, context, { userId, sessionId }) {
  if (!context) return providerSession;
  const { ticket, connectionId } = issueViduDemoTicket({ secret: context.secret,
    userId, sessionId, liveId: providerSession.liveId, clientSecret: providerSession.token,
    origin: context.origin, audience: context.audience, maxSeconds: providerSession.sessionLimit,
    providerExpiresAt: providerSession.expiresAt });
  return { ...providerSession, token: ticket,
    signaling: { transport: 'proxy', path: '/api/vidu/live', connectionId, origin: context.relayOrigin } };
}

// Match the provided quick-start launcher's normalization for vda_ API keys.
function getViduAuthorizationHeader(apiKey) {
  return /^Token\s/i.test(apiKey) ? apiKey : `Token ${apiKey}`;
}

function getViduSessionRequestTimeoutMs() {
  const configured = Number(process.env.VIDU_SESSION_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5000 ? Math.min(60000, Math.floor(configured)) : 15000;
}

function getViduRequestErrorCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  const allowed = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);
  const candidates = [error, error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.slice(0, 5) : [])];
  return candidates.map(candidate => candidate?.code).find(code => allowed.has(code)) || null;
}

export function normalizeRealtimeProvider(value) {
  if (value === 'xmax') return 'xmax';
  return value === 'decart' ? 'decart' : DEFAULT_REALTIME_PROVIDER;
}

// Plus = Xmax (2 cr/s), Pro = Vidu (2.5 cr/s). Rates are stored in half-credits.
export const REALTIME_ENGINE_RATE_HALF = { xmax: 4, vidu: 5, decart: 5 };
export function getEngineCreditRate(provider) {
  return (REALTIME_ENGINE_RATE_HALF[provider] || 4) / 2;
}
export function getEngineMinimumCredits(provider) {
  return getEngineCreditRate(provider) * VIDU_MIN_START_SECONDS;
}

const XMAX_API_BASE_URL = 'https://api.xmax.ai/open/api/v1';
const XMAX_REALTIME_MODEL = 'x2.1';

function getXmaxApiKey() {
  const key = String(process.env.XMAX_API_KEY || '').trim();
  return key || null;
}

/**
 * Mint a short-lived Xmax temporary key (tk-...) for one browser session.
 * The permanent key never leaves the server.
 */
export async function createXmaxTemporaryKey({ apiKey, maxSeconds, fetchImpl = fetch }) {
  const expireSeconds = Math.max(60, Math.min(Math.ceil(Number(maxSeconds) || 0) + 120, 4 * 3600));
  const pointsLimit = Math.max(1, Number(process.env.XMAX_TEMP_KEY_POINTS_LIMIT) || 100000);
  let response;
  try {
    response = await fetchImpl(`${XMAX_API_BASE_URL}/temporary-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ expireSeconds, pointsLimit, temporaryApiKeySessionLimit: 3 }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { error: { error: 'Plus could not reach its video service. Please try again.', providerStatus: 0 } };
  }
  const payload = await response.json().catch(() => null);
  const token = payload?.data?.temporaryApiKey;
  if (!response.ok || !payload?.success || typeof token !== 'string' || !token.startsWith('tk-')) {
    return { error: { error: 'Plus could not start a session right now. Please try again.', providerStatus: response.status, providerCode: payload?.code ?? null } };
  }
  const expireTimestamp = Number(payload.data.expireTimestamp);
  return {
    token,
    expiresAt: new Date(Number.isFinite(expireTimestamp) && expireTimestamp > 0
      ? (expireTimestamp < 1e12 ? expireTimestamp * 1000 : expireTimestamp)
      : Date.now() + expireSeconds * 1000).toISOString(),
    sessionLimit: maxSeconds,
  };
}

function getProviderModel(provider) {
  if (provider === 'xmax') return XMAX_REALTIME_MODEL;
  return provider === 'decart' ? DECART_REALTIME_MODEL : VIDU_REALTIME_MODEL;
}

function getProviderApiKey(provider) {
  if (provider === 'xmax') return getXmaxApiKey();
  return provider === 'decart' ? getDecartApiKey() : getViduApiKey();
}

function getProviderPublicLabel(provider) {
  return provider === 'xmax' ? 'Plus' : 'Pro';
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
  if (sessionLimit < 10) return { error: { error: 'INSUFFICIENT_CREDITS', details: 'At least 25 credits are needed to start this session.' } };
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
      return { error: { error: 'AI_SESSION_CREATION_FAILED', providerStatus: response.status, details: 'Morphly could not start a secure session. Please try again.' } };
    }
    return { token: data.apiKey, expiresAt: data.expiresAt, sessionLimit };
  } catch {
    return { error: { error: 'AI_SESSION_CREATION_FAILED', details: 'Morphly could not connect. Please try again.' } };
  }
}

export async function createViduTemporaryKey({
  apiKey,
  maxSeconds,
  userId,
  sessionId,
  installationId,
  imageUrl,
  proxyContext,
}) {
  const sessionLimit = Math.max(1, Math.min(Math.floor(Number(maxSeconds) || 1), 7200));
  const baseUrl = getViduApiBaseUrl();
  if (!baseUrl) return { error: VIDU_CONFIG_ERROR };

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
  if (!/^(https?:\/\/|data:image\/(png|jpeg|webp);base64,|ssupload:)/i.test(effectiveImageUrl)) {
    return { error: { error: 'INVALID_REFERENCE_IMAGE', details: 'Unsupported reference image format. Upload a JPG, PNG or WEBP photo.' } };
  }
  if (effectiveImageUrl.length > 3_500_000) {
    return { error: { error: 'INVALID_REFERENCE_IMAGE', details: 'The reference image is too large. Upload a smaller photo (under 2 MB).' } };
  }

  const requestTimeoutMs = getViduSessionRequestTimeoutMs();
  const requestDeadline = Date.now() + requestTimeoutMs;
  for (let attempt = 1; attempt <= VIDU_TOKEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/live/s_editing/realtime`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: getViduAuthorizationHeader(apiKey),
          ...(proxyContext ? { Origin: proxyContext.origin, 'User-Agent': proxyContext.userAgent } : {}),
        },
        body: JSON.stringify({
          image_url: effectiveImageUrl,
          editing_type: 'subject_replacement',
        }),
        signal: AbortSignal.timeout(Math.max(1, requestDeadline - Date.now())),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const providerStatus = response.status;
        const providerCode = data?.code || data?.error_code || null;
        const message = data?.message || data?.error || response.statusText;
        const retryable = providerStatus === 429;
        const unavailable = providerStatus >= 500;
        const moderationRejected = /submit is illegal|audit|policy violation/i.test(String(message || ''))
          || /AuditSubmitIllegal|PhotoAuditNotPass|AuditFailed|CreationPolicyViolation/i.test(String(providerCode || ''));

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

        if (moderationRejected) {
          return {
            error: {
              error: 'REFERENCE_IMAGE_REJECTED',
              providerStatus,
              providerCode,
              details: REFERENCE_IMAGE_REJECTED_MESSAGE,
            },
          };
        }

        const details = providerStatus === 401 || providerStatus === 403
          ? 'Plus could not authorize this session. Try again or contact Morphly support.'
          : providerStatus === 429
            ? 'Plus is limiting new sessions right now. Wait a moment, then try again.'
            : unavailable
              ? 'Plus servers are busy or under maintenance right now. Wait a minute, then try again.'
              : 'Plus could not start this session. Try again or contact Morphly support.';

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
          details: 'Plus could not start a secure session. Try again or contact Morphly support.',
        } };
      }
      const renderUid = String(data?.render_uid || data?.data?.render_uid || '');
      const rtc = data?.rtc || data?.data?.rtc || null;
      if (!liveId || !renderUid || typeof rtc?.token !== 'string' || !rtc.token || rtc.token === apiKey || !rtc.user_id) {
        return { error: { error: 'VIDU_RTC_CREDENTIAL_MISSING', details: 'Plus could not prepare the video connection. Please try again.' } };
      }
      // Vidu reports RTC expiry as Unix seconds; the scoped secret shares that deadline.
      const credentialExpiries = [
        Number(rtc.token_expire_at) * 1000,
        Date.parse(data?.expires_at || data?.data?.expires_at || ''),
      ].filter(value => Number.isFinite(value) && value > 0 && value <= 8.64e15);
      const expiryMs = credentialExpiries.length
        ? Math.min(...credentialExpiries)
        : Date.now() + sessionLimit * 1000;
      if (expiryMs <= Date.now()) {
        return { error: { error: 'VIDU_SESSION_EXPIRED', details: 'This Plus session has expired. Start a new session.' } };
      }
      if (['ending', 'ended'].includes(data?.live?.status || data?.data?.live?.status)) {
        return { error: { error: 'VIDU_SESSION_ENDED', details: 'This Plus session has ended. Start a new session.' } };
      }
      const expiresAt = new Date(expiryMs).toISOString();

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
      const providerCode = getViduRequestErrorCode(error);
      const isTimeout = providerCode === 'TIMEOUT' || providerCode === 'UND_ERR_CONNECT_TIMEOUT' || providerCode === 'UND_ERR_HEADERS_TIMEOUT';
      console.warn('[Vidu] request exception', {
        operation: 'create_session', host: new URL(baseUrl).hostname,
        requestTimeoutMs, providerCode,
      });

      return {
        error: {
          error: 'AI_SESSION_CREATION_FAILED',
          providerStatus: isTimeout ? 408 : null,
          providerCode,
          details: isTimeout
            ? 'Plus timed out while creating its video session. Try again shortly.'
            : 'Plus could not create its video session. Please try again.',
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
  proxyContext,
}) {
  if (provider === 'xmax') return createXmaxTemporaryKey({ apiKey, maxSeconds });
  if (provider === 'decart') return createScopedDecartKey({apiKey,maxSeconds,allowedOrigins,userId,sessionId});
  if (provider === 'vidu' || provider === 'decart') {
    return createViduTemporaryKey({
      apiKey,
      maxSeconds,
      userId,
      sessionId,
      installationId,
      imageUrl,
      proxyContext,
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

    if (req.body?.provider !== 'vidu' && req.body?.provider !== 'xmax') {
      return res.status(400).json({ allowed: false, error: 'Choose Plus or Pro. Update Morphly and try again.' });
    }

    const provider = normalizeRealtimeProvider(req.body?.provider);
    const isXmax = provider === 'xmax';
    const minimumCreditRate = getEngineCreditRate(provider);
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
      const environmentName = isXmax ? 'XMAX_API_KEY' : provider === 'decart' ? 'DECART_API_KEY' : 'VIDU_API_KEY';
      return res.status(503).json({
        allowed: false,
        error: `${getProviderPublicLabel(provider)} is not configured on this server.`,
        details: `${getProviderPublicLabel(provider)} is unavailable (${environmentName} missing). Please contact Morphly support.`,
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
        error: 'Open Morphly from the app or a secure web address, then try again.',
      });
    }
    const proxyContext = isXmax ? null : getViduDemoSessionContext(req);
    if (proxyContext?.error) return res.status(503).json({ allowed: false, ...proxyContext.error });
    if (!isXmax && !getViduApiBaseUrl()) return res.status(503).json({ allowed: false, ...VIDU_CONFIG_ERROR });

    // Fire-and-forget: request logging must not delay session startup.
    void logRequestEvent('start-session.request', {
      method: req.method,
      path: '/api/start-session',
      userId,
      provider,
      model: providerModel,
    });

    const validationStartedAt = Date.now();
    // Independent account, wallet, and stale-session checks share one
    // network round trip instead of delaying startup in a serial chain.
    const [profileResult, activeSessionsResult, walletResult] = await Promise.all([
      supabaseAdmin.from('users').select('account_status').eq('id', userId).maybeSingle(),
      selectActiveSessions(userId),
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
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
    if (userCredits < getEngineMinimumCredits(provider)) {
      await logRequestEvent('start-session.insufficient_credits', {
        userId,
        credits: userCredits,
      });
      return res.json({ allowed: false, error: `${getProviderPublicLabel(provider)} needs at least ${getEngineMinimumCredits(provider)} credits to start (${minimumCreditRate} cr/sec). Top up and try again.` });
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
      p_user: userId, p_session: newSession.id, p_rate_half: REALTIME_ENGINE_RATE_HALF[provider] || 4,
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
    let providerSession = await createProviderTemporaryCredential({
      provider,
      apiKey: providerApiKey,
      maxSeconds,
      allowedOrigins,
      userId,
      sessionId: newSession.id,
      installationId,
      imageUrl: req.body?.imageUrl || req.body?.image_url || req.body?.referenceImage,
      proxyContext,
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

    if (!isXmax) try {
      providerSession = createViduDemoSignalingSession(providerSession, proxyContext, { userId, sessionId: newSession.id });
    } catch {
      await closeExistingSession({ id: newSession.id, seconds_used: 0, cost: 0 });
      return res.status(503).json({ allowed: false, ...VIDU_CONFIG_ERROR });
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
      ...(provider === 'xmax' ? { referenceSoftening: readXmaxReferenceSoftening() } : {}),
      serverNow: Date.now(),
      maxSeconds: providerSession.sessionLimit || maxSeconds,
      baseUrl: providerSession.baseUrl,
      token: providerSession.token,
      liveId: providerSession.liveId,
      traceId: providerSession.traceId,
      renderUid: providerSession.renderUid,
      rtc: providerSession.rtc,
      signaling: providerSession.signaling,
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

// Plus-only reference preprocessing, tunable without a rebuild via Vercel env vars
// (unset = client defaults in src/lib/xmax-reference-softening.ts):
//   XMAX_REFERENCE_BLUR_PERCENT (0.5)  XMAX_REFERENCE_BRIGHTNESS (0.94)  XMAX_REFERENCE_CONTRAST (0.92)
//   XMAX_REFERENCE_DOWNSCALE (0.75)    XMAX_REFERENCE_MAX_SIDE (512)     XMAX_REFERENCE_QUALITY (0.9)
const XMAX_REFERENCE_ENV = {
  blurPercent: 'XMAX_REFERENCE_BLUR_PERCENT', brightness: 'XMAX_REFERENCE_BRIGHTNESS', contrast: 'XMAX_REFERENCE_CONTRAST',
  downscale: 'XMAX_REFERENCE_DOWNSCALE', maxSide: 'XMAX_REFERENCE_MAX_SIDE', quality: 'XMAX_REFERENCE_QUALITY',
};
export function readXmaxReferenceSoftening(env: Record<string, string | undefined> = process.env) {
  const out: Record<string, number> = {};
  for (const [key, name] of Object.entries(XMAX_REFERENCE_ENV)) {
    const raw = env[name];
    const n = Number(raw);
    if (raw !== undefined && raw.trim() !== '' && Number.isFinite(n)) out[key] = n;
  }
  return out; // client clamps and fills defaults
}
