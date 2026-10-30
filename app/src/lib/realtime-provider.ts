// Plus = Xmax X2.1 (2 cr/s). Pro = Vidu S2-Editing (2.5 cr/s).
export const XMAX_REALTIME_PROVIDER = 'xmax' as const;
export const DEFAULT_REALTIME_PROVIDER = XMAX_REALTIME_PROVIDER;
export const VIDU_REALTIME_PROVIDER = 'vidu' as const;
export const VIDU_REALTIME_MODEL = 's2-editing' as const;
export const DECART_REALTIME_PROVIDER = 'decart' as const;
export const DECART_REALTIME_MODEL = 'lucy-2.5' as const;
export type RealtimeProvider = typeof XMAX_REALTIME_PROVIDER | typeof VIDU_REALTIME_PROVIDER | typeof DECART_REALTIME_PROVIDER;
export const REALTIME_PROVIDER_CREDITS_PER_SECOND: Record<RealtimeProvider, number> = { xmax: 2, vidu: 2.5, decart: 2.5 };
export const REALTIME_PROVIDER_OPTIONS: ReadonlyArray<{ value: RealtimeProvider; label: string; detail: string; short: string }> = [
  { value: XMAX_REALTIME_PROVIDER, label: 'Plus', detail: '2 credits per second', short: 'Plus · 2 cr/s' },
  { value: VIDU_REALTIME_PROVIDER, label: 'Pro', detail: '2.5 credits per second', short: 'Pro · 2.5 cr/s' },
];
export function isRealtimeProvider(value: unknown): value is RealtimeProvider {
  return value === XMAX_REALTIME_PROVIDER || value === VIDU_REALTIME_PROVIDER;
}
/** Both engines are reference-image subject replacement engines. */
export function isReferenceImageProvider(value: unknown): boolean {
  return value === XMAX_REALTIME_PROVIDER || value === VIDU_REALTIME_PROVIDER;
}
export function getRealtimeProviderLabel(provider: RealtimeProvider): string {
  return provider === XMAX_REALTIME_PROVIDER ? 'Plus' : 'Pro';
}
/** Vidu (Pro) internals still say "Plus" in their messages; relabel at display time. */
export function relabelProviderMessage(message: string, provider: RealtimeProvider): string {
  return provider === XMAX_REALTIME_PROVIDER ? message : message.replace(/\bPlus(?=\b|’|')/g, 'Pro');
}
export function resolveRealtimeProvider(value: unknown, fallback: RealtimeProvider = DEFAULT_REALTIME_PROVIDER): RealtimeProvider {
  return isRealtimeProvider(value) ? value : fallback;
}
export function resolveRealtimeModel(provider: RealtimeProvider, _value: unknown): string {
  if (provider === XMAX_REALTIME_PROVIDER) return 'x2.1';
  return provider === DECART_REALTIME_PROVIDER ? DECART_REALTIME_MODEL : VIDU_REALTIME_MODEL;
}

/** Seconds of credit required (each engine) before a start is allowed (mirrors app/server/api/start-session.ts). */
export const VIDU_MIN_START_SECONDS = 15;
export function getMinimumCreditsToStart(_provider: RealtimeProvider, ratePerSecond: number): number {
  return ratePerSecond * VIDU_MIN_START_SECONDS;
}
export function getNotEnoughCreditsMessage(provider: RealtimeProvider, minimum: number): string {
  return `Not enough credits. ${getRealtimeProviderLabel(provider)} needs at least ${Math.ceil(minimum)} credits to start. Buy credits to continue.`;
}

function getProviderRealtimeUserMessage(error: unknown, label: string, _alternative: string, fallback: string): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = error instanceof Error ? error.message : typeof candidate?.message === 'string' ? candidate.message : '';
  const diagnostic = `${code} ${message}`.toLowerCase();
  if (/moderation|unsafe|rejected|policy/.test(diagnostic)) return `${label} did not accept that image. Choose another reference and try again.`;
  if (/insufficient credits|credit balance|payment required|quota/.test(diagnostic)) return `${label} is temporarily unavailable because its provider capacity is exhausted. Please try again later.`;
  if (/token|auth|unauthor|expired|forbidden/.test(diagnostic)) return `The ${label} session expired. Stop the stream and start it again.`;
  if (isRealtimeNetworkDiagnostic(diagnostic)) return `The ${label} connection was interrupted. Morphly is trying to recover it.`;
  return sanitizeProviderNames(message || fallback);
}

// Word boundaries matter: a bare /ice/ also matched "device", "service", "price".
function isRealtimeNetworkDiagnostic(diagnostic: string): boolean {
  // Letter-only boundaries so codes like WEBRTC_ERROR / ICE_FAILED still match.
  return /webrtc|(?<![a-z])rtc(?![a-z])|network|socket|signaling|connect|(?<![a-z])ice(?![a-z])|timed out|timeout/.test(diagnostic);
}

function sanitizeProviderNames(text: string): string {
  return text
    .replace(/\b(?:[a-z0-9-]+\.)?vidu\.(?:com|cn)\b/gi, 'Plus')
    .replace(/\bvidu(?:[_-][a-z0-9_-]+)?\b/gi, 'Plus')
    .replace(/\bdecart(?:[_-][a-z0-9_-]+)?\b/gi, 'Pro');
}

/**
 * Message for a session that failed to START. Unlike mid-stream errors nothing
 * is auto-recovering here, so never say so, and keep the underlying reason
 * visible so user screenshots are diagnosable.
 */
export function getViduStartErrorMessage(error: unknown, fallback: string): string {
  const candidate = error as { code?: unknown; message?: unknown; providerCode?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = error instanceof Error ? error.message : typeof candidate?.message === 'string' ? candidate.message : '';
  const diagnostic = `${code} ${message}`.toLowerCase();
  const detail = sanitizeProviderNames(message || fallback).slice(0, 180);

  if (code === 'REFERENCE_IMAGE_REJECTED' || code === 'INVALID_REFERENCE_IMAGE') {
    return sanitizeProviderNames(message || fallback);
  }
  if (code === 'AI_SESSION_CREATION_FAILED') {
    if (['TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(String(candidate?.providerCode))) {
      return 'Plus timed out while creating its video session. Try again shortly.';
    }
    return detail;
  }
  // Our own wallet check (server: "Plus needs at least 30 credits" / legacy "Insufficient credits").
  if (/needs at least \d+ credits|insufficient credits|not enough credits/.test(diagnostic) && !/provider/.test(diagnostic)) {
    return /needs at least|not enough credits/.test(diagnostic)
      ? sanitizeProviderNames(message)
      : 'Not enough credits. Plus needs at least 30 credits to start. Buy credits to continue.';
  }
  if (code === 'credits_exhausted' || /credit balance ran out/.test(diagnostic)) {
    return 'Plus stopped because your credit balance ran out. Buy credits to continue.';
  }
  // The provider ended the session (hangup, renderer left, sip_close). This is not the
  // user's internet, so never tell them to check their connection for it.
  if (/sip_close|ended this session|video service ended|rendering ended|rendering connection closed|rtc session ended|renderer but received no usable|could not receive its generated video|could not initialize this session/.test(diagnostic)) {
    return `Plus's video server ended the session before it finished starting. You were not charged for this attempt. Please try again. (${detail})`;
  }
  if (code === 'VIDU_SIGNALING_UNREACHABLE') {
    return 'Plus could not connect to its video server. Start a new session and try again.';
  }
  if (/timed out|timeout/.test(diagnostic)) {
    return `Plus did not return video in time. Check your internet connection, then try again. (${detail})`;
  }
  if (isRealtimeNetworkDiagnostic(diagnostic)) {
    return `Plus could not connect. Check your internet connection, then try again. (${detail})`;
  }
  return getViduRealtimeUserMessage(error, fallback);
}
export function getViduRealtimeUserMessage(error: unknown, fallback = 'Plus could not complete that realtime request. Please try again.'): string {
  return getProviderRealtimeUserMessage(error, 'Plus', 'Pro', fallback);
}
export function getDecartRealtimeUserMessage(error: unknown, fallback = 'Pro could not complete that realtime request. Please try again.'): string {
  return getProviderRealtimeUserMessage(error, 'Pro', 'Plus', fallback);
}
