import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { getViduApiBaseUrl, getViduDemoSessionContext, createViduDemoSignalingSession, createViduTemporaryKey } from '../server/api/start-session.ts';
import { getViduDemoAudience, hasViduDemoProxySecret, isViduDemoProxyEnabled, issueViduDemoTicket, validateViduDemoTicket } from '../server/vidu-demo-ticket.js';

const secret = randomBytes(32).toString('base64url');
const environment = { VERCEL_ENV: 'preview', VIDU_DEMO_PROXY: 'true', VIDU_API_BASE_URL: 'https://api.vidu.com',
  VIDU_DEMO_PROXY_SECRET: secret, VERCEL_URL: 'morphly-test.vercel.app' };
const req = { headers: { origin: 'https://morphly-test.vercel.app', host: 'morphly-test.vercel.app', 'user-agent': 'Test browser' }, body: { platform: 'web' } };
const context = (request = req, env = environment) => getViduDemoSessionContext(request, { environment: env, supabase: { db: {} } });

test('Vidu accepts only canonical HTTPS official API base URLs', () => {
  for (const base of ['https://api.vidu.com', 'https://api.vidu.cn/']) {
    assert.equal(getViduApiBaseUrl({ VIDU_API_BASE_URL: base }), base.replace(/\/$/, ''));
  }
  for (const base of ['vda_private-test-key', 'https://api.vidu.com.evil.test', 'http://api.vidu.com',
    'https://api.vidu.com/live', 'https://name:password@api.vidu.com', 'https://api.vidu.com?secret=x', 'https://api.vidu.com#x', 'https://api.vidu.com:444']) {
    assert.equal(getViduApiBaseUrl({ VIDU_API_BASE_URL: base }), null);
  }
});

test('invalid provider configuration fails before a network request or secret-bearing log', async t => {
  const previous = process.env.VIDU_API_BASE_URL;
  t.after(() => { if (previous === undefined) delete process.env.VIDU_API_BASE_URL; else process.env.VIDU_API_BASE_URL = previous; });
  process.env.VIDU_API_BASE_URL = 'vda_private-test-key';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('Unexpected fetch'); });
  t.mock.method(console, 'warn', () => assert.fail('Invalid configuration must not log its value'));
  const result = await createViduTemporaryKey({ apiKey: 'server-key', maxSeconds: 60, imageUrl: 'https://example.com/image.png' });
  assert.equal(result.error.error, 'AI_SESSION_CONFIG_INVALID');
  assert.equal(JSON.stringify(result).includes('vda_private-test-key'), false);
  assert.equal(calls, 0);
});

test('proxy context validates deployment configuration and exact browser origin', () => {
  assert.equal(context().origin, req.headers.origin);
  assert.equal(context().relayOrigin, req.headers.origin);
  for (const patch of [{ VERCEL_ENV: 'development' }, { VIDU_API_BASE_URL: 'https://api.vidu.cn' },
    { VIDU_DEMO_PROXY_SECRET: '' }, { VERCEL_URL: '' }]) {
    assert.equal(context(req, { ...environment, ...patch }).error.error, 'AI_SESSION_CONFIG_INVALID');
  }
  for (const origin of ['null', 'https://different.example', 'http://morphly-test.vercel.app', '', 'https://morphly-test.vercel.app/']) {
    assert.equal(context({ ...req, headers: { ...req.headers, origin } }).error.error, 'INVALID_BROWSER_ORIGIN');
  }
  assert.equal(getViduDemoSessionContext(req, { environment: {} }), null);
  assert.equal(getViduDemoSessionContext(req, { environment, supabase: {} }).error.error, 'AI_SESSION_CONFIG_INVALID');
});

test('opaque Electron origin is accepted only for desktop and alias destinations keep deployment audience', () => {
  const desktopReq = { headers: { ...req.headers, origin: 'null', host: 'preview.morphly.example' }, body: { platform: 'desktop' } };
  const result = context(desktopReq);
  assert.equal(result.origin, 'null');
  assert.equal(result.relayOrigin, 'https://preview.morphly.example');
  assert.equal(result.audience, environment.VERCEL_URL);
  assert.equal(context({ ...desktopReq, body: { platform: 'web' } }).error.error, 'INVALID_BROWSER_ORIGIN');
});

test('demo session creation forwards browser headers and uses Token authorization', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.vidu.com');
    assert.equal(options.headers.Origin, req.headers.origin);
    assert.equal(options.headers['User-Agent'], req.headers['user-agent']);
    assert.equal(options.headers.Authorization, 'Token server-key');
    assert.deepEqual(JSON.parse(options.body), { image_url: 'https://example.com/image.png', editing_type: 'subject_replacement' });
    return Response.json({ client_secret: 'provider-session-secret', live: { id: 'live-123' }, render_uid: 'render-123',
      rtc: { token: 'rtc-session-secret', user_id: 'camera-123', token_expire_at: Math.floor(Date.now() / 1000) + 7200 } });
  });
  const providerSession = await createViduTemporaryKey({ apiKey: 'server-key', maxSeconds: 60,
    imageUrl: 'https://example.com/image.png', proxyContext: context() });
  const wrapped = createViduDemoSignalingSession(providerSession, context(), { userId: 'user-123', sessionId: 'session-123' });
  const payload = validateViduDemoTicket(wrapped.token, { secret, audience: environment.VERCEL_URL, origin: req.headers.origin });
  assert.equal(payload.clientSecret, 'provider-session-secret');
  assert.equal(payload.userId, 'user-123');
  assert.equal(payload.sessionId, 'session-123');
  assert.equal(wrapped.signaling.connectionId, payload.connectionId);
  assert.equal(wrapped.signaling.origin, req.headers.origin);
  assert.equal(wrapped.signaling.path, '/api/vidu/live');
  assert.equal(wrapped.rtc, providerSession.rtc);
  assert.equal(wrapped.expiresAt, providerSession.expiresAt);
  assert.equal(JSON.stringify(wrapped).includes('provider-session-secret'), false);
  assert.equal(JSON.stringify(wrapped).includes('server-key'), false);
  assert.equal(createViduDemoSignalingSession(providerSession, null, {}), providerSession);
});

test('production retains scoped credentials for legacy clients and issues encrypted tickets only to capable clients', async t => {
  const production = { ...environment, VERCEL_ENV: 'production' };
  const providerSecret = 'fixture-scoped-provider-secret';
  const rtcToken = 'fixture-rtc-secret';
  let creations = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    creations++;
    return Response.json({ client_secret: providerSecret, live: { id: 'fixture-live' }, render_uid: 'fixture-renderer',
      rtc: { token: rtcToken, user_id: 'fixture-camera-user', token_expire_at: Math.floor(Date.now() / 1000) + 7200 } });
  });
  for (const [platform, origin] of [['web', req.headers.origin], ['desktop', 'null']]) {
    for (const signalingTransport of [undefined, '', 'proxy', 'morphly-proxy-v2', 'morphly-proxy-v1']) {
      const request = { ...req, headers: { ...req.headers, origin }, body: { platform, signalingTransport } };
      const sessionContext = context(request, production);
      const providerSession = await createViduTemporaryKey({ apiKey: 'fixture-server-key', maxSeconds: 60,
        imageUrl: 'https://example.com/image.png', proxyContext: sessionContext });
      const response = createViduDemoSignalingSession(providerSession, sessionContext,
        { userId: 'fixture-owner', sessionId: 'fixture-session' });
      assert.equal(response.rtc.token, rtcToken);
      assert.equal(response.liveId, 'fixture-live');
      assert.equal(response.renderUid, 'fixture-renderer');
      assert.equal(response.expiresAt, providerSession.expiresAt);
      if (signalingTransport === 'morphly-proxy-v1') {
        assert.equal(response.signaling.transport, 'proxy');
        assert.equal(response.signaling.origin, req.headers.origin);
        const ticket = validateViduDemoTicket(response.token, { secret, audience: production.VERCEL_URL, origin });
        assert.equal(ticket.clientSecret, providerSecret);
        assert.equal(ticket.origin, origin);
        assert.equal(ticket.userId, 'fixture-owner');
        assert.equal(ticket.sessionId, 'fixture-session');
        assert.equal(JSON.stringify(response).includes(providerSecret), false);
      } else {
        assert.equal(sessionContext, null);
        assert.equal(response, providerSession);
        assert.equal(response.token, providerSecret);
        assert.equal(response.signaling, undefined);
      }
    }
  }
  assert.equal(creations, 10, 'capability checks never add or retry provider creation');
  assert.ok(context(req), 'the deployed preview remains compatible without a capability field');
});

test('enabled production validates relay configuration before allowing legacy compatibility', () => {
  const production = { ...environment, VERCEL_ENV: 'production' };
  assert.equal(context(req, production), null);
  for (const signalingTransport of [undefined, 'morphly-proxy-v1']) {
    const request = { ...req, body: { ...req.body, signalingTransport } };
    for (const patch of [{ VIDU_DEMO_PROXY_SECRET: '' }, { VERCEL_URL: '' }, { VIDU_API_BASE_URL: 'https://api.vidu.cn' }]) {
      assert.equal(context(request, { ...production, ...patch }).error.error, 'AI_SESSION_CONFIG_INVALID');
    }
    assert.equal(getViduDemoSessionContext(request, { environment: production, supabase: {} }).error.error,
      'AI_SESSION_CONFIG_INVALID');
  }
  assert.equal(context(req, { ...production, VIDU_DEMO_PROXY: 'false' }), null);
});

test('production relay requires exact HTTPS web origins and permits opaque origins only for desktop', () => {
  const production = { ...environment, VERCEL_ENV: 'production' };
  const capable = { ...req, body: { platform: 'web', signalingTransport: 'morphly-proxy-v1' } };
  assert.equal(context(capable, production).origin, req.headers.origin);
  const alias = { ...capable, headers: { ...req.headers, host: 'live.morphly.fun', origin: 'https://live.morphly.fun' } };
  assert.equal(context(alias, production).relayOrigin, 'https://live.morphly.fun');
  assert.equal(context(alias, production).audience, production.VERCEL_URL);
  for (const platform of ['web', 'desktop']) {
    for (const origin of ['http://localhost:5173', 'https://morphly-test.vercel.app/', '', undefined]) {
      assert.equal(context({ ...capable, headers: { ...req.headers, origin }, body: { ...capable.body, platform } }, production)
        .error.error, 'INVALID_BROWSER_ORIGIN');
    }
  }
  for (const origin of ['null', 'https://untrusted.example']) {
    assert.equal(context({ ...capable, headers: { ...req.headers, origin } }, production).error.error, 'INVALID_BROWSER_ORIGIN');
  }
  const desktop = { ...capable, headers: { ...req.headers, origin: 'null' }, body: { ...capable.body, platform: 'desktop' } };
  assert.equal(context(desktop, production).origin, 'null');
});

test('production preflight rejects invalid relay configuration and origins before database mutations or provider creation', async () => {
  const source = readFileSync(new URL('../server/api/start-session.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const scenario of [
    { patch: { VIDU_DEMO_PROXY_SECRET: '' }, signalingTransport: undefined, expected: 'AI_SESSION_CONFIG_INVALID' },
    { patch: { VIDU_DEMO_PROXY_SECRET: '' }, signalingTransport: 'morphly-proxy-v1', expected: 'AI_SESSION_CONFIG_INVALID' },
    { patch: { VIDU_API_BASE_URL: 'https://api.vidu.cn' }, signalingTransport: 'morphly-proxy-v1', expected: 'AI_SESSION_CONFIG_INVALID' },
    { origin: 'https://untrusted.example', signalingTransport: 'morphly-proxy-v1', expected: 'INVALID_BROWSER_ORIGIN' },
    { origin: 'http://localhost:5173', platform: 'desktop', signalingTransport: 'morphly-proxy-v1', expected: 'INVALID_BROWSER_ORIGIN' },
    { origin: 'null', signalingTransport: 'morphly-proxy-v1', expectedStatus: 400,
      expected: 'A canonical browser origin is required to start an AI session.' },
  ]) {
    const exports = {};
    let providerCalls = 0;
    let databaseCalls = 0;
    const supabaseAdmin = { db: {}, from() { databaseCalls++; throw new Error('Unexpected database mutation'); } };
    const fakeEnvironment = { ...environment, VERCEL_ENV: 'production', VIDU_API_KEY: 'fixture-server-key', ...scenario.patch };
    vm.runInNewContext(compiled, { exports, process: { env: fakeEnvironment }, URL, Date,
      setTimeout, clearTimeout, fetch() { providerCalls++; throw new Error('Unexpected provider creation'); },
      console: { warn() { assert.fail('Preflight must not log configuration values'); }, error() {} },
      require(name) {
        if (name === 'crypto') return { default: crypto };
        if (name === '../local-preview.js') return { isLocalPreviewRequest: () => false };
        if (name === '../supabase-admin.js') return { supabaseAdmin };
        if (name === '../../../shared/admin-auth.js') return { authenticateRequestUser: async () => ({ user: { id: 'fixture-owner' } }) };
        if (name === '../vidu-demo-ticket.js') return { getViduDemoAudience, hasViduDemoProxySecret, isViduDemoProxyEnabled, issueViduDemoTicket };
        if (name === '../../../shared/backend-logger.js') return { logErrorEvent() {}, logRequestEvent() {} };
        if (name === '../realtime-billing.js') return { realtimeWalletBalance: Number };
        if (name === '../decart-token.js') return {};
        throw new Error(`Unexpected import ${name}`);
      },
    });
    const request = { method: 'POST', headers: { ...req.headers, origin: scenario.origin ?? req.headers.origin },
      body: { provider: 'vidu', platform: scenario.platform || 'web', signalingTransport: scenario.signalingTransport } };
    const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await exports.default(request, response);
    assert.equal(response.code, scenario.expectedStatus || 503);
    assert.equal(response.body.error, scenario.expected);
    assert.equal(providerCalls, 0);
    assert.equal(databaseCalls, 0);
  }
});

test('the released Dashboard advertises its relay capability with the start-session request', () => {
  const dashboard = readFileSync(new URL('../src/pages/Dashboard.tsx', import.meta.url), 'utf8');
  const startRequest = dashboard.slice(dashboard.indexOf("apiRequest<AiSessionResponse>('/start-session'"));
  assert.match(startRequest.slice(0, startRequest.indexOf('if (!startResponse.allowed)')),
    /getTrustedApiOrigin\(\) \? \{ signalingTransport: 'morphly-proxy-v1' \}/);
});
