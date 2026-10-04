import test from 'node:test';
import assert from 'node:assert/strict';
import { createPasswordResetFlow } from '../src/lib/password-reset.ts';

const user = { id: 'recovery-user', email: 'person@example.com' };
function fixture(overrides = {}) {
  const calls = [];
  const auth = {
    resetPasswordForEmail: async email => { calls.push(['request', email]); return { error: null }; },
    verifyOtp: async payload => { calls.push(['verify', payload]); return { data: { session: { user } }, error: null }; },
    getUser: async () => ({ data: { user }, error: null }),
    updateUser: async payload => { calls.push(['update', payload]); return { data: { user }, error: null }; },
    signOut: async payload => { calls.push(['signOut', payload]); return { error: null }; },
    ...overrides,
  };
  return { flow: createPasswordResetFlow(auth), calls };
}

test('recovery requests normalized email and verifies a recovery OTP before password update', async () => {
  const { flow, calls } = fixture();
  await flow.request(' PERSON@EXAMPLE.COM ');
  await flow.verify(' PERSON@EXAMPLE.COM ', '123 456');
  await flow.update('new password ', 'new password ');
  assert.deepEqual(calls, [
    ['request', user.email], ['verify', { email: user.email, token: '123456', type: 'recovery' }],
    ['update', { password: 'new password ' }], ['signOut', { scope: 'local' }],
  ]);
  await assert.rejects(flow.update('another password', 'another password'), /Verify your reset code/);
});

test('saved sessions and malformed codes cannot authorize a password update', async () => {
  const { flow, calls } = fixture();
  await assert.rejects(flow.update('new password', 'new password'), /Verify/);
  await assert.rejects(flow.request('invalid'), /valid email/);
  for (const code of ['12345', 'abcdef', '12345678901']) await assert.rejects(flow.verify(user.email, code), /numeric code/);
  assert.deepEqual(calls, []);
});

test('expired, wrong-purpose or mismatched-account verification cannot update passwords', async () => {
  for (const overrides of [
    { verifyOtp: async () => ({ error: new Error('Expired code') }) },
    { verifyOtp: async () => ({ data: { session: null }, error: null }) },
    { getUser: async () => ({ data: { user: { ...user, id: 'other' } } }) },
    { getUser: async () => ({ data: { user: { ...user, email: 'other@example.com' } } }) },
    { getUser: async () => ({ error: new Error('Expired session') }) },
  ]) {
    const { flow } = fixture(overrides);
    await assert.rejects(flow.verify(user.email, '123456'));
    await assert.rejects(flow.update('password123', 'password123'), /Verify/);
  }
});

test('password validation and provider failures preserve verification for a retry', async () => {
  let attempts = 0;
  const { flow } = fixture({ updateUser: async () => ++attempts === 1 ? { error: new Error('Try again') } : { data: { user } } });
  await flow.verify(user.email, '123456');
  await assert.rejects(flow.update('short', 'short'), /eight/);
  await assert.rejects(flow.update('password123', 'different'), /match/);
  assert.equal(attempts, 0);
  await assert.rejects(flow.update('password123', 'password123'), /Try again/);
  await flow.update('password123', 'password123');
  assert.equal(attempts, 2);
});

test('resending clears prior verification and rate limiting propagates', async () => {
  const { flow } = fixture();
  await flow.verify(user.email, '123456');
  await flow.request(user.email);
  await assert.rejects(flow.update('password123', 'password123'), /Verify/);
  const rateLimited = fixture({ resetPasswordForEmail: async () => ({ error: new Error('Rate limited') }) });
  await assert.rejects(rateLimited.flow.request(user.email), /Rate limited/);
});
