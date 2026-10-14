import { firebaseSessionClient } from './firebase-auth';

const DEPLOYED_APP_ORIGIN = import.meta.env.VITE_PUBLIC_APP_URL || 'https://morphly-alpha.vercel.app';
const LOCAL_API_BASE = '/api';

function normalizeApiBase(value?: string | null): string | null {
  if (!value) return null;

  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;

  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function isFileProtocol(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'file:';
}

// A packaged app is loaded from file:// or runs within Electron.
export function isMorphlyDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && (
    isFileProtocol() || Boolean(window.electron?.isElectron)
  );
}

function getApiBase(): string {
  // If running in pure web preview (not desktop), use relative /api
  if (!isMorphlyDesktopRuntime() && (import.meta.env.DEV || !isFileProtocol())) {
    return LOCAL_API_BASE;
  }

  const configuredBase = normalizeApiBase(
    import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL,
  );

  if (configuredBase && configuredBase.startsWith('/') && isMorphlyDesktopRuntime()) {
    return `${DEPLOYED_APP_ORIGIN}/api`;
  }

  return configuredBase || `${DEPLOYED_APP_ORIGIN}/api`;
}

export function getTrustedApiOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.location.protocol === 'https:'
    ? window.location.origin
    : isMorphlyDesktopRuntime() ? (getApiBase().startsWith('http') ? getApiBase() : DEPLOYED_APP_ORIGIN) : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function withLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const normalizedPath = withLeadingSlash(path);
  const apiBase = getApiBase();
  return fetch(`${apiBase}${normalizedPath}`, init);
}

export async function apiFetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
  let { data: { session } } = await firebaseSessionClient.auth.getSession();
  if (!session?.access_token) {
    const refreshResult = await firebaseSessionClient.auth.refreshSession();
    session = refreshResult.data.session;
  }

  if (!session?.access_token) {
    throw new Error('AUTH_SESSION_REQUIRED');
  }
  const headers = new Headers(init?.headers || {});
  headers.set('Authorization', `Bearer ${session.access_token}`);

  return apiFetch(path, {
    ...init,
    headers,
  });
}
