import { firebaseSessionClient } from './firebase-auth';

const DEPLOYED_APP_ORIGIN = 'https://live.morphly.fun';
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

function getApiBase(): string {
  // Web previews must use the API from the same deployment. A production API
  // URL here silently connects a new provider UI to an older server contract.
  if (import.meta.env.DEV || !isFileProtocol()) {
    return LOCAL_API_BASE;
  }

  const configuredBase = normalizeApiBase(
    import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL,
  );

  if (configuredBase && configuredBase.startsWith('/') && isFileProtocol()) {
    return `${DEPLOYED_APP_ORIGIN}/api`;
  }

  return configuredBase || `${DEPLOYED_APP_ORIGIN}/api`;
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
