import { establishRecoverySession, INVALID_LINK, readRecoveryLink, recoveryClientOptions, validateNewPassword } from './password-recovery.mjs';

const form = document.querySelector('#resetForm');
const fields = document.querySelector('#passwordFields');
const button = document.querySelector('#updatePassword');
const message = document.querySelector('#resetMessage');
const password = document.querySelector('#newPassword');
const confirmation = document.querySelector('#confirmPassword');
let client = null;
let ready = false;
let busy = false;

function feedback(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
  message.setAttribute('role', error ? 'alert' : 'status');
  message.focus();
}

// Install before async work: a bad link must never cause native form navigation.
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!ready || busy || !client) return;
  const invalid = validateNewPassword(password.value, confirmation.value);
  password.removeAttribute('aria-invalid'); confirmation.removeAttribute('aria-invalid');
  if (invalid) {
    (password.value.length < 8 ? password : confirmation).setAttribute('aria-invalid', 'true');
    feedback(invalid, true); return;
  }
  busy = true; fields.disabled = true; button.textContent = 'Updating password…';
  let updated = false;
  try {
    const { data, error } = await client.auth.updateUser({ password: password.value });
    if (error) throw error;
    if (!data?.user) throw new Error('The password update could not be verified. Please try again.');
    updated = true; ready = false;
    password.value = ''; confirmation.value = '';
    try { await client.auth.signOut({ scope: 'local' }); } catch { /* Recovery storage is memory-only. */ }
    feedback('Password updated. Sign in to Morphly with your new password.');
    document.querySelector('#requestReset').hidden = true;
    document.querySelector('#backToSignIn').textContent = 'Sign in with your new password';
  } catch (error) {
    if (['session_not_found', 'refresh_token_not_found', 'bad_jwt'].includes(error?.code) || error?.status === 401 || error?.status === 403) ready = false;
    feedback(ready ? (error?.message || 'Unable to update your password. Please try again.') : INVALID_LINK, true);
  } finally {
    busy = false; fields.disabled = !ready;
    button.textContent = updated ? 'Password updated' : 'Update password';
  }
});

async function initialize() {
  let link;
  try { link = readRecoveryLink(window.location.href); }
  finally { window.history.replaceState(null, '', window.location.pathname); }
  const response = await fetch('/api/public-config', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Unable to load password recovery. Reopen the email link and try again.');
  const config = await response.json();
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) throw new Error('Password recovery is unavailable. Please try again later.');
  const originalVerifierKey = `sb-${new URL(config.supabaseUrl).hostname.split('.')[0]}-auth-token-code-verifier`;
  let verifier = null;
  if (link.kind === 'pkce') {
    try { verifier = window.localStorage.getItem(originalVerifierKey); } catch { /* Browser storage may be disabled. */ }
    let decoded;
    try { decoded = JSON.parse(verifier); } catch { /* Invalid verifier is rejected below. */ }
    if (typeof decoded !== 'string' || !decoded.endsWith('/recovery')) {
      throw new Error('Open this link in the browser where you requested it, or request a new password reset email.');
    }
  }
  const storageKey = `morphly-recovery-${crypto.randomUUID()}`;
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, recoveryClientOptions(storageKey, verifier));
  try { await establishRecoverySession(client.auth, link); }
  finally { if (link.kind === 'pkce') { try { window.localStorage.removeItem(originalVerifierKey); } catch { /* No session tokens are stored by this page. */ } } }
  ready = true; fields.disabled = false;
  feedback('Reset link verified. Enter and confirm your new password.');
  password.focus();
}

void initialize().catch(error => { fields.disabled = true; feedback(error?.message || INVALID_LINK, true); });
