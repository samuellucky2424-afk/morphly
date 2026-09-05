export const INVALID_LINK = 'This reset link is invalid or has expired. Request a new password reset email.';

export function readRecoveryLink(href) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const query = url.searchParams;
  if (hash.has('error') || hash.has('error_code') || query.has('error') || query.has('error_code')) throw new Error(INVALID_LINK);
  if (hash.get('type') === 'recovery' && hash.get('access_token') && hash.get('refresh_token')) {
    return { kind: 'implicit', access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token') };
  }
  if (query.get('type') === 'recovery' && query.get('token_hash')) return { kind: 'otp', token_hash: query.get('token_hash') };
  if (query.get('code')) return { kind: 'pkce', code: query.get('code') };
  throw new Error(INVALID_LINK);
}

// Memory-only storage and a unique key isolate recovery from an account already
// signed in on this browser. Copy only a PKCE recovery verifier, never a session.
export function recoveryClientOptions(storageKey, verifier = null) {
  const values = new Map();
  if (verifier) values.set(`${storageKey}-code-verifier`, verifier);
  return { auth: {
    storageKey, flowType: 'pkce', detectSessionInUrl: false, autoRefreshToken: false,
    persistSession: true,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } },
  } };
}

export async function establishRecoverySession(auth, link) {
  let result;
  if (link.kind === 'implicit') result = await auth.setSession({ access_token: link.access_token, refresh_token: link.refresh_token });
  else if (link.kind === 'otp') result = await auth.verifyOtp({ token_hash: link.token_hash, type: 'recovery' });
  else if (link.kind === 'pkce') {
    result = await auth.exchangeCodeForSession(link.code);
    if (result.data?.redirectType !== 'recovery') throw new Error(INVALID_LINK);
  } else throw new Error(INVALID_LINK);
  if (result.error || !result.data?.session?.user?.id) throw new Error(INVALID_LINK);
  const verified = await auth.getUser();
  if (verified.error || verified.data?.user?.id !== result.data.session.user.id) throw new Error(INVALID_LINK);
  return verified.data.user;
}

export function validateNewPassword(password, confirmation) {
  if (password.length < 8) return 'Use at least eight characters for your new password.';
  if (password !== confirmation) return 'Passwords do not match.';
  return null;
}
