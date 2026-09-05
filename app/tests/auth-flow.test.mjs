import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getRegistrationOutcome, getPasswordResetUrl, normalizeEmail } from '../src/lib/auth-flow.ts';
import { readRecoveryLink, recoveryClientOptions, establishRecoverySession, validateNewPassword } from '../../morphly-admin-dashboard/password-recovery.mjs';
const user = { id: 'test-user', email: 'person@example.com', identities: [{ id: 'email-identity' }] };
const session = { access_token: 'fixture-token', user };

test('signup distinguishes an actual session, confirmation and obfuscated duplicate', () => {
  assert.equal(getRegistrationOutcome({ user, session }, ' PERSON@EXAMPLE.COM '), 'signed_in');
  assert.equal(getRegistrationOutcome({ user, session: null }, user.email), 'confirmation_required');
  assert.throws(() => getRegistrationOutcome({ user: { ...user, identities: [] }, session: null }, user.email), /already exists.*Forgot password/);
  assert.throws(() => getRegistrationOutcome({ user: null, session: null }, user.email), /could not be verified/);
  assert.throws(() => getRegistrationOutcome({ user, session: { ...session, user: { id: 'someone-else' } } }, user.email), /could not be verified/);
  assert.throws(() => getRegistrationOutcome({ user, session }, 'different@example.com'), /could not be verified/);
});

test('email normalization and browser recovery URL work for desktop without file URLs', () => {
  assert.equal(normalizeEmail(' PERSON@EXAMPLE.COM '), user.email);
  assert.equal(getPasswordResetUrl(), 'https://morphly-alpha.vercel.app/reset-password');
  assert.equal(getPasswordResetUrl('https://live.morphly.fun/'), 'https://live.morphly.fun/reset-password');
  for (const url of ['file:///app/index.html','http://example.com','javascript:alert(1)','https://name:password@example.com']) {
    assert.throws(() => getPasswordResetUrl(url));
  }
});

test('recovery rejects missing, incomplete, expired and non-recovery links', () => {
  for (const suffix of ['', '#access_token=a', '#type=signup&access_token=a&refresh_token=r', '?type=signup&token_hash=x', '#error=access_denied&type=recovery&access_token=a&refresh_token=r']) {
    assert.throws(() => readRecoveryLink('https://example.com/reset-password'+suffix), /invalid or has expired/);
  }
  assert.equal(readRecoveryLink('https://example.com/reset-password#type=recovery&access_token=a&refresh_token=r').kind, 'implicit');
  assert.equal(readRecoveryLink('https://example.com/reset-password?type=recovery&token_hash=x').kind, 'otp');
  assert.equal(readRecoveryLink('https://example.com/reset-password?code=x').kind, 'pkce');
});

test('recovery requires a verified recovery session, never a previously saved login', async () => {
  const auth = {
    setSession: async () => ({ data: { session }, error: null }),
    verifyOtp: async value => { assert.equal(value.type, 'recovery'); return { data: { session }, error: null }; },
    exchangeCodeForSession: async () => ({ data: { session, redirectType: 'recovery' }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    getSession: () => assert.fail('must not fall back to saved account'),
  };
  for (const link of [{ kind: 'implicit' }, { kind: 'otp' }, { kind: 'pkce' }]) assert.equal((await establishRecoverySession(auth, link)).id, user.id);
  await assert.rejects(establishRecoverySession({ ...auth, getUser: async () => ({ error: new Error('expired') }) }, { kind: 'implicit' }), /invalid/);
  await assert.rejects(establishRecoverySession({ ...auth, exchangeCodeForSession: async () => ({ data: { session, redirectType: null } }) }, { kind: 'pkce' }), /invalid/);
  await assert.rejects(establishRecoverySession({ ...auth, setSession: async () => ({ error: new Error('invalid') }) }, { kind: 'implicit' }), /invalid/);
});

test('recovery storage is isolated and password validation retains whitespace', () => {
  const first = recoveryClientOptions('recovery-a', '"verifier/recovery"').auth;
  const second = recoveryClientOptions('recovery-b').auth;
  assert.equal(first.detectSessionInUrl, false);
  assert.equal(first.storage.getItem('recovery-a-code-verifier'), '"verifier/recovery"');
  first.storage.setItem('recovery-a', 'temporary-session');
  assert.equal(second.storage.getItem('recovery-a'), null);
  assert.match(validateNewPassword('short', 'short'), /eight/);
  assert.match(validateNewPassword('password', 'different'), /match/);
  assert.equal(validateNewPassword(' long password ', ' long password '), null);
});

test('auth does not unmount forms on submission or report unconfirmed signups as complete', async () => {
  const context = await readFile(new URL('../src/context/AuthContext.tsx', import.meta.url), 'utf8');
  const login = await readFile(new URL('../src/pages/Login.tsx', import.meta.url), 'utf8');
  const guards = await readFile(new URL('../src/components/ProtectedRoute.tsx', import.meta.url), 'utf8');
  assert.match(context, /if \(outcome === 'confirmation_required'\) return outcome/);
  assert.match(context, /const registeredSession = data.session/);
  assert.doesNotMatch(login, /toast\.|Account created successfully/);
  assert.match(login, /role=\{error \|\| requestError \? 'alert' : 'status'\}/);
  assert.match(guards, /if \(initializing\)/);
  assert.doesNotMatch(guards, /if \(loading\)/);
});
