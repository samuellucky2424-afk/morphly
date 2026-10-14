export const DEFAULT_REALTIME_PROVIDER = 'vidu' as const;
export const VIDU_REALTIME_PROVIDER = 'vidu' as const;
export const VIDU_REALTIME_MODEL = 's2-editing' as const;
export const DECART_REALTIME_PROVIDER = 'decart' as const;
export const DECART_REALTIME_MODEL = 'lucy-2.5' as const;
export type RealtimeProvider = typeof VIDU_REALTIME_PROVIDER | typeof DECART_REALTIME_PROVIDER;
export const REALTIME_PROVIDER_OPTIONS: ReadonlyArray<{ value: RealtimeProvider; label: string; detail: string }> = [
  { value: VIDU_REALTIME_PROVIDER, label: 'Plus', detail: '2 credits per second' },
];
export function isRealtimeProvider(value: unknown): value is RealtimeProvider {
  return value === VIDU_REALTIME_PROVIDER;
}
export function getRealtimeProviderLabel(provider: RealtimeProvider): string {
  return provider === DECART_REALTIME_PROVIDER ? 'Pro' : 'Plus';
}
export function resolveRealtimeProvider(value: unknown, fallback: RealtimeProvider = DEFAULT_REALTIME_PROVIDER): RealtimeProvider {
  return isRealtimeProvider(value) ? value : fallback;
}
export function resolveRealtimeModel(provider: RealtimeProvider, _value: unknown): string {
  return provider === DECART_REALTIME_PROVIDER ? DECART_REALTIME_MODEL : VIDU_REALTIME_MODEL;
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
  return (message || fallback).replace(/\bDecart\b/gi, 'Pro').replace(/\bVidu\b/gi, 'Plus');
}

// Word boundaries matter: a bare /ice/ also matched "device", "service", "price".
function isRealtimeNetworkDiagnostic(diagnostic: string): boolean {
  // Letter-only boundaries so codes like WEBRTC_ERROR / ICE_FAILED still match.
  return /webrtc|(?<![a-z])rtc(?![a-z])|network|socket|signaling|connect|(?<![a-z])ice(?![a-z])|timed out|timeout/.test(diagnostic);
}

function sanitizeProviderNames(text: string): string {
  return text.replace(/\bDecart\b/gi, 'Pro').replace(/\bVidu\b/gi, 'Plus');
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

  if (code === 'AI_SESSION_CREATION_FAILED') {
    if (['TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(String(candidate?.providerCode))) {
      return 'Plus timed out while creating its video session. Try again shortly.';
    }
    return detail;
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
