export const DEFAULT_REALTIME_PROVIDER = 'vidu' as const;
export const VIDU_REALTIME_PROVIDER = 'vidu' as const;
export const VIDU_REALTIME_MODEL = 's2-editing' as const;
export const DECART_REALTIME_PROVIDER = 'decart' as const;
export const DECART_REALTIME_MODEL = 'lucy-2.5' as const;
export type RealtimeProvider = typeof VIDU_REALTIME_PROVIDER | typeof DECART_REALTIME_PROVIDER;
export const REALTIME_PROVIDER_OPTIONS: ReadonlyArray<{ value: RealtimeProvider; label: string; detail: string }> = [
  { value: VIDU_REALTIME_PROVIDER, label: 'Plus', detail: '2 credits per second' },
  { value: DECART_REALTIME_PROVIDER, label: 'Pro', detail: '2.5 credits per second' },
];
export function isRealtimeProvider(value: unknown): value is RealtimeProvider {
  return value === VIDU_REALTIME_PROVIDER || value === DECART_REALTIME_PROVIDER;
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

function getProviderRealtimeUserMessage(error: unknown, label: string, alternative: string, fallback: string): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = error instanceof Error ? error.message : typeof candidate?.message === 'string' ? candidate.message : '';
  const diagnostic = `${code} ${message}`.toLowerCase();
  if (/moderation|unsafe|rejected|policy/.test(diagnostic)) return `${label} did not accept that image or prompt. Choose another reference and try again.`;
  if (/insufficient credits|credit balance|payment required|quota/.test(diagnostic)) return `${label} is temporarily unavailable because its provider capacity is exhausted. Please use ${alternative} or try ${label} again later.`;
  if (/token|auth|unauthor|expired|forbidden/.test(diagnostic)) return `The ${label} session expired. Stop the stream and start it again.`;
  if (/webrtc|rtc|network|socket|connect|ice|timeout/.test(diagnostic)) return `The ${label} connection was interrupted. Morphly is trying to recover it.`;
  return (message || fallback).replace(/\bDecart\b/gi, 'Pro').replace(/\bVidu\b/gi, 'Plus');
}
export function getViduRealtimeUserMessage(error: unknown, fallback = 'Plus could not complete that realtime request. Please try again.'): string {
  return getProviderRealtimeUserMessage(error, 'Plus', 'Pro', fallback);
}
export function getDecartRealtimeUserMessage(error: unknown, fallback = 'Pro could not complete that realtime request. Please try again.'): string {
  return getProviderRealtimeUserMessage(error, 'Pro', 'Plus', fallback);
}
