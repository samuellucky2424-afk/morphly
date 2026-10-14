import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { issueViduDemoTicket, validateViduDemoTicket, isViduDemoProxyEnabled, hasViduDemoProxySecret, getViduDemoAudience } from '../server/vidu-demo-ticket.js';

const secret = randomBytes(32).toString('base64url');
const now = Date.now();
const input = { secret, userId: 'owner', sessionId: 'morphly-session', liveId: 'provider-live', clientSecret: 'scoped-provider-secret',
  origin: 'https://preview.example', audience: 'immutable-preview.vercel.app', maxSeconds: 999, providerExpiresAt: now + 3600000, now };

test('proxy ticket authenticates and encrypts scoped credentials with bounded acquisition and session duration', () => {
  const issued = issueViduDemoTicket(input);
  assert.equal(Date.parse(issued.expiresAt), now + 120000);
  assert.doesNotMatch(issued.ticket, /scoped-provider-secret|provider-live|owner/);
  const payload = validateViduDemoTicket(issued.ticket, { secret, audience: input.audience, origin: input.origin, now });
  assert.equal(payload.connectionId, issued.connectionId);
  assert.equal(payload.clientSecret, input.clientSecret);
  assert.equal(payload.maxSeconds, 120);
  assert.equal(payload.providerExpiresAt, input.providerExpiresAt);
  assert.notEqual(issueViduDemoTicket(input).ticket, issued.ticket);
});

test('proxy ticket rejects tampering, wrong secret, audience, origin, expiry, and invalid server configuration', () => {
  const { ticket } = issueViduDemoTicket(input);
  const parts = ticket.split('.');
  const bytes = Buffer.from(parts[2], 'base64url'); bytes[0] ^= 1; parts[2] = bytes.toString('base64url');
  const validate = (value, overrides = {}) => validateViduDemoTicket(value, { secret, audience: input.audience, now, ...overrides });
  for (const value of [parts.join('.'), '', 'v1.invalid', ticket + '.extra']) assert.throws(() => validate(value), /INVALID_TICKET/);
  assert.throws(() => validate(ticket, { secret: randomBytes(32).toString('base64url') }), /INVALID_TICKET/);
  assert.throws(() => validate(ticket, { audience: 'different-deployment' }), /INVALID_TICKET/);
  assert.throws(() => validate(ticket, { origin: 'https://attacker.example' }), /INVALID_TICKET/);
  assert.throws(() => validate(ticket, { now: now + 120000 }), /EXPIRED_TICKET/);
  assert.throws(() => validate(ticket, { now: now - 10000 }), /INVALID_TICKET/);
  for (const value of ['', undefined, 'server-api-key', randomBytes(31).toString('base64url')]) {
    assert.equal(hasViduDemoProxySecret(value), false);
    assert.throws(() => issueViduDemoTicket({ ...input, secret: value }), /INVALID_PROXY_SECRET/);
  }
});

test('provider expiry bounds ticket acquisition and noncanonical origins cannot be issued', () => {
  const issued = issueViduDemoTicket({ ...input, providerExpiresAt: new Date(now + 3000).toISOString(), maxSeconds: 20 });
  assert.equal(Date.parse(issued.expiresAt), now + 3000);
  for (const origin of ['http://preview.example', 'https://preview.example/', 'https://preview.example/path', 'https://name:password@preview.example']) {
    assert.throws(() => issueViduDemoTicket({ ...input, origin }), /INVALID_TICKET/);
  }
  assert.throws(() => issueViduDemoTicket({ ...input, providerExpiresAt: now }), /INVALID_TICKET/);
  const desktop = issueViduDemoTicket({ ...input, origin: 'null' });
  assert.equal(validateViduDemoTicket(desktop.ticket, { secret, audience: input.audience, origin: 'null', now }).origin, 'null');
  assert.throws(() => validateViduDemoTicket(desktop.ticket, { secret, audience: input.audience, origin: input.origin, now }), /INVALID_TICKET/);
});

test('proxy activation requires preview or production, explicit flag, and the exact global provider base', () => {
  const env = { VERCEL_ENV: 'preview', VIDU_DEMO_PROXY: 'true', VIDU_API_BASE_URL: 'https://api.vidu.com', VERCEL_URL: input.audience };
  assert.equal(isViduDemoProxyEnabled(env), true);
  assert.equal(isViduDemoProxyEnabled({ ...env, VERCEL_ENV: 'production' }), true);
  assert.equal(getViduDemoAudience(env), input.audience);
  for (const overrides of [{ VERCEL_ENV: 'development' }, { VERCEL_ENV: undefined }, { VERCEL_ENV: 'Production' },
    { VIDU_DEMO_PROXY: undefined }, { VIDU_DEMO_PROXY: 'false' }, { VIDU_DEMO_PROXY: 'TRUE' },
    { VIDU_API_BASE_URL: 'https://api.vidu.cn' }, { VIDU_API_BASE_URL: 'https://api.vidu.com/' }, { VIDU_API_BASE_URL: 'https://api.vidu.com.attacker.example' }]) {
    assert.equal(isViduDemoProxyEnabled({ ...env, ...overrides }), false);
  }
});
