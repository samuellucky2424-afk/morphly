import { apiFetchWithAuth, apiFetch } from './api-client';

type TelemetryEventName =
  | 'download_clicked'
  | 'first_app_open'
  | 'signup_started'
  | 'signup_completed'
  | 'login_success'
  | 'payment_started'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'decart_token_requested'
  | 'connection_started'
  | 'connection_failed'
  | 'first_frame_received'
  | 'session_completed'
  | 'session_disconnected';

type TelemetryMetadata = Record<string, string | number | boolean>;

let cachedInstallationId: string | null = null;
const sentEventsThisSession = new Set<string>();

function getInstallationId(): string {
  if (cachedInstallationId) return cachedInstallationId;

  const STORAGE_KEY = 'morphly_installation_id';
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(STORAGE_KEY, id);
    }
    cachedInstallationId = id;
    return id;
  } catch {
    cachedInstallationId = `inst_${Date.now().toString(36)}`;
    return cachedInstallationId;
  }
}

function detectPlatform(): string {
  if (typeof window !== 'undefined' && (window as any).electron) {
    return 'desktop';
  }
  return 'web';
}

function getAppVersion(): string | null {
  try {
    return (import.meta as any).env?.VITE_APP_VERSION || null;
  } catch {
    return null;
  }
}

/**
 * Fire a telemetry event. Events with the same name and deduplication key
 * are only sent once per page session to avoid noise.
 *
 * If no auth token is available (e.g. pre-login events), the event is still
 * sent — the backend accepts unauthenticated telemetry with a null userId.
 */
export async function trackEvent(
  eventName: TelemetryEventName,
  options?: {
    sessionId?: string;
    metadata?: TelemetryMetadata;
    acquisitionSource?: string;
    /** If true, allow the same event name to be sent multiple times this session */
    allowDuplicate?: boolean;
    /** Use authenticated fetch (default: true) */
    authenticated?: boolean;
  },
): Promise<void> {
  const dedupeKey = options?.allowDuplicate
    ? `${eventName}:${Date.now()}`
    : eventName;

  if (sentEventsThisSession.has(dedupeKey)) return;
  sentEventsThisSession.add(dedupeKey);

  const payload = {
    eventName,
    installationId: getInstallationId(),
    sessionId: options?.sessionId || null,
    platform: detectPlatform(),
    appVersion: getAppVersion(),
    acquisitionSource: options?.acquisitionSource || null,
    metadata: options?.metadata || {},
  };

  try {
    const fetchFn = options?.authenticated === false ? apiFetch : apiFetchWithAuth;
    await fetchFn('/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry is best-effort; never let it break the app flow.
  }
}

/** Convenience: fire login_success */
export function trackLogin(sessionId?: string): void {
  void trackEvent('login_success', { sessionId });
}

/** Convenience: fire signup_completed */
export function trackSignupCompleted(sessionId?: string): void {
  void trackEvent('signup_completed', { sessionId });
}

/** Convenience: fire connection_started */
export function trackConnectionStarted(sessionId?: string, metadata?: TelemetryMetadata): void {
  void trackEvent('connection_started', { sessionId, metadata, allowDuplicate: true });
}

/** Convenience: fire connection_failed */
export function trackConnectionFailed(sessionId?: string, metadata?: TelemetryMetadata): void {
  void trackEvent('connection_failed', { sessionId, metadata, allowDuplicate: true });
}

/** Convenience: fire first_frame_received */
export function trackFirstFrameReceived(sessionId?: string): void {
  void trackEvent('first_frame_received', { sessionId });
}

/** Convenience: fire session_completed */
export function trackSessionCompleted(sessionId?: string, metadata?: TelemetryMetadata): void {
  void trackEvent('session_completed', { sessionId, metadata, allowDuplicate: true });
}

/** Convenience: fire session_disconnected */
export function trackSessionDisconnected(sessionId?: string, metadata?: TelemetryMetadata): void {
  void trackEvent('session_disconnected', { sessionId, metadata, allowDuplicate: true });
}

/** Convenience: fire payment_started */
export function trackPaymentStarted(metadata?: TelemetryMetadata): void {
  void trackEvent('payment_started', { metadata, allowDuplicate: true });
}

/** Convenience: fire payment_succeeded */
export function trackPaymentSucceeded(metadata?: TelemetryMetadata): void {
  void trackEvent('payment_succeeded', { metadata, allowDuplicate: true });
}

/** Convenience: fire payment_failed */
export function trackPaymentFailed(metadata?: TelemetryMetadata): void {
  void trackEvent('payment_failed', { metadata, allowDuplicate: true });
}
