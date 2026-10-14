const TOKEN_REJECTION_CODES = new Set([
  'auth/argument-error', 'auth/invalid-argument', 'auth/invalid-id-token',
  'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found',
]);
const TRANSPORT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'PERMISSION_DENIED', 'UNAUTHENTICATED', 'UNAVAILABLE']);

function safeCode(error) {
  const code = String(error?.code || 'unknown');
  return /^(auth|app)\/[a-z-]{1,60}$/.test(code) || /^\d{1,3}$/.test(code) || TRANSPORT_CODES.has(code)
    ? code : 'unknown';
}

export function createFirebaseUserLookup({ auth, mapUser,
  logger = details => console.warn('[FirebaseAuth] lookup failed', details) }) {
  return async token => {
    let stage = 'verify_token';
    try {
      const decoded = await auth.verifyIdToken(token, true);
      stage = 'load_user';
      const record = await auth.getUser(decoded.uid);
      stage = 'load_profile';
      return { data: { user: await mapUser(record) }, error: null };
    } catch (error) {
      const code = safeCode(error);
      // Firebase sometimes wraps certificate/network failures as invalid-argument.
      const infrastructure = /credential|certificate|fetch.*public.*key|ENOTFOUND|EAI_AGAIN|ECONN|network/i.test(error?.message || '');
      const status = stage !== 'load_profile' && TOKEN_REJECTION_CODES.has(code) && !infrastructure ? 401 : 503;
      try { logger({ stage, code }); } catch { /* Diagnostics must not break authentication. */ }
      return { data: null, error: { code, status,
        message: status === 401 ? 'Invalid or expired access token' : 'Account verification is temporarily unavailable' } };
    }
  };
}
