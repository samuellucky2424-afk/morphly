import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIDU_REALTIME_PROVIDER,
  VIDU_REALTIME_MODEL,
  DEFAULT_REALTIME_PROVIDER,
  REALTIME_PROVIDER_OPTIONS,
  getViduRealtimeUserMessage,
  getViduStartErrorMessage,
  getRealtimeProviderLabel,
  resolveRealtimeModel,
  resolveRealtimeProvider,
} from '../src/lib/realtime-provider.ts';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
const appShell = fs.readFileSync(path.join(appDirectory, 'src/App.tsx'), 'utf8');
const startSessionApi = fs.readFileSync(path.join(appDirectory, 'server/api/start-session.ts'), 'utf8');

test('Plus (Xmax) and Pro (Vidu) are the two realtime engines', () => {
  assert.equal(DEFAULT_REALTIME_PROVIDER, 'xmax');
  assert.deepEqual(REALTIME_PROVIDER_OPTIONS.map(({ value }) => value), ['xmax', 'vidu']);
  assert.deepEqual(REALTIME_PROVIDER_OPTIONS.map(({ short }) => short), ['Plus · 2 cr/s', 'Pro · 2.5 cr/s']);
  assert.equal(getRealtimeProviderLabel('xmax'), 'Plus');
  assert.equal(getRealtimeProviderLabel('vidu'), 'Pro');
  assert.equal(resolveRealtimeProvider(undefined), 'xmax');
  assert.equal(resolveRealtimeProvider('vidu'), 'vidu');
  assert.equal(resolveRealtimeProvider('decart'), 'xmax');
});

test('Vidu uses the native S2-Editing character model', () => {
  assert.equal(VIDU_REALTIME_MODEL, 's2-editing');
  assert.equal(resolveRealtimeModel('vidu', 's2-editing'), 's2-editing');
  assert.equal(resolveRealtimeModel('vidu', 'invalid'), 's2-editing');
});

test('Vidu realtime errors provide actionable user messages', () => {
  assert.match(getViduRealtimeUserMessage({ message: 'Rejected by moderation' }), /Plus did not accept/i);
  assert.match(getViduRealtimeUserMessage({ message: 'Insufficient credits' }), /provider capacity is exhausted/i);
  assert.match(getViduRealtimeUserMessage({ code: 'WEBRTC_ERROR' }), /Plus connection was interrupted/i);
  const sanitized = getViduRealtimeUserMessage({ message: 'VIDU_API_KEY is missing at service.vidu.com.' });
  assert.match(sanitized, /Plus is missing at Plus\./);
  assert.doesNotMatch(sanitized, /vidu/i);
  assert.match(dashboard, /getViduStartErrorMessage\(error, fallback\)/);
});

test('start failures keep the real reason and never claim auto-recovery', () => {
  const signaling = getViduStartErrorMessage(
    Object.assign(new Error('Plus signaling could not connect. Retry.'), { code: 'VIDU_SIGNALING_UNREACHABLE' }),
    'x',
  );
  assert.match(signaling, /connect to its video server/);
  assert.doesNotMatch(signaling, /api\.vidu\.com|firewall|VPN/);

  const timeout = getViduStartErrorMessage(new Error('Plus connection timed out after 45s'), 'x');
  assert.match(timeout, /did not return video in time/);
  assert.match(timeout, /timed out after 45s/);

  const rtc = getViduStartErrorMessage(new Error('Vidu RTC session ended. Start a new session.'), 'x');
  // The provider ending the RTC session is not the user's internet connection.
  assert.match(rtc, /video server ended the session/);
  assert.doesNotMatch(rtc, /internet connection/);
  assert.match(rtc, /Plus RTC session ended/);

  for (const message of [signaling, timeout, rtc]) {
    assert.doesNotMatch(message, /trying to recover/);
  }

  // "device"/"service" must not be misread as ICE (network) errors.
  assert.equal(
    getViduStartErrorMessage(new Error('The selected camera device is unavailable.'), 'x'),
    'The selected camera device is unavailable.',
  );
});

test('server session-creation failures are distinct from receiving-video or user-token failures', () => {
  const error = Object.assign(new Error('The upstream call timed out'), {
    code: 'AI_SESSION_CREATION_FAILED', providerCode: 'TIMEOUT', providerStatus: 408,
  });
  const message = getViduStartErrorMessage(error, 'x');
  assert.match(message, /creating its video session/);
  assert.doesNotMatch(message, /internet connection|return video|expired|recover/);
  assert.equal(getViduStartErrorMessage({ code: 'AI_SESSION_CREATION_FAILED', message: 'Plus could not authenticate with its video service.' }, 'x'),
    'Plus could not authenticate with its video service.');
});

test('dashboard shows the single engine without an engine chooser', () => {
  assert.match(dashboard, /data-testid="realtime-provider-selector"/);
  assert.doesNotMatch(dashboard, /EngineChoice|connectToDecart|decartSdkReadyPromise/);
  assert.match(dashboard, /provider: requestedProvider/);
  assert.match(dashboard, /connectToRealtimeProvider/);
  assert.match(dashboard, /mirror: 'auto'/);
  assert.match(dashboard, /resolution: '720p'/);
  assert.match(dashboard, /const PRO_CAMERA_FPS = 30/);
  assert.match(dashboard, /buildProviderVideoInputConstraints\(attemptedMode, provider/);
});

test('Vidu token creation retries transient failures and preserves the HTTP status', () => {
  assert.match(startSessionApi, /VIDU_TOKEN_MAX_ATTEMPTS = 2/);
  assert.match(startSessionApi, /providerStatus === 429/);
  assert.match(startSessionApi, /providerStatus >= 500/);
});

test('startup avoids stacked retries and reports each connection phase', () => {
  assert.match(dashboard, /vidu: 1,[\s\S]*decart: 2/);
  assert.match(dashboard, /decart: 45000,[\s\S]*vidu: 45000/);
  assert.match(dashboard, /Checking stream setup/);
  assert.match(dashboard, /Opening camera/);
  assert.match(dashboard, /Authorizing \$\{requestedProviderLabel\}/);
  assert.match(dashboard, /Connecting to \$\{requestedProviderLabel\}/);
  // Session-start cooldowns (recentTokenMints) were removed in 2ee22ed; the
  // remaining startup lookups must still load in parallel.
  assert.match(startSessionApi, /\[profileResult, activeSessionsResult, walletResult\] = await Promise\.all/);
  assert.doesNotMatch(startSessionApi, /recentTokenMints/);
  assert.match(startSessionApi, /startupTimings/);
  assert.doesNotMatch(startSessionApi, /updateSessionProviderAudit/);
});

test('dashboard feedback uses a persistent accessible error panel without corner toasts', () => {
  assert.match(dashboard, /data-testid="dashboard-error-panel"/);
  assert.match(dashboard, /role="alert"/);
  assert.match(dashboard, /aria-live="assertive"/);
  assert.match(dashboard, /Try again/);
  assert.match(dashboard, /Dismiss error/);
  assert.doesNotMatch(dashboard, /toast\./);
  assert.doesNotMatch(dashboard, /from ['"]sonner['"]/);
  assert.match(appShell, /function RouteAwareToaster/);
  assert.match(appShell, /pathname === ROUTES\.PROTECTED\.DASHBOARD/);
  assert.match(appShell, /<RouteAwareToaster \/>/);
});

test('provider-side hangups and credit limits are not reported as connection problems', () => {
  for (const raw of [
    'Plus’s rendering connection closed before the session finished (sip_close). Please try again. Stage: renderer_online.',
    'Vidu ended this session (renderer_timeout). Please try again. Stage: published.',
    'Plus rendering ended. Start a new session. Stage: renderer_subscribed.',
  ]) {
    const message = getViduStartErrorMessage(new Error(raw), 'x');
    assert.match(message, /video server ended the session/);
    assert.doesNotMatch(message, /internet connection/i);
  }
  assert.match(
    getViduStartErrorMessage(new Error('Plus needs at least 30 credits to start (2 cr/sec). Top up and try again.'), 'x'),
    /needs at least 30 credits/,
  );
  assert.match(getViduStartErrorMessage(new Error('Insufficient credits'), 'x'), /Not enough credits.*30 credits/);
  assert.match(
    getViduStartErrorMessage(new Error('Plus stopped because your credit balance ran out. Buy credits to continue. Stage: video_received.'), 'x'),
    /credit balance ran out/,
  );
  assert.match(getViduStartErrorMessage(new Error('Plus could not connect to its video room. Stage: rtc_joining.'), 'x'), /internet connection/);
});

test('client minimum-credit check matches the server (30 credits for Plus)', async () => {
  const { getMinimumCreditsToStart, getNotEnoughCreditsMessage } = await import('../src/lib/realtime-provider.ts');
  assert.equal(getMinimumCreditsToStart('vidu', 2), 30);
  assert.match(getNotEnoughCreditsMessage('vidu', 30), /needs at least 30 credits/);
  const server = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/api/start-session.ts'), 'utf8');
  assert.match(server, /VIDU_MIN_START_SECONDS = 15/);
});

test('Xmax provider-side endings are not reported as an internet problem', () => {
  const msg = getViduStartErrorMessage(new Error('Plus video service ended the session before video started. You were not charged; please try again.'), 'fallback');
  assert.doesNotMatch(msg, /internet connection/i);
  assert.match(msg, /not charged/i);
});

test('Xmax adapter does not treat the initial Idle state as a disconnect', () => {
  const src = fs.readFileSync(path.join(appDirectory, 'src/lib/xmax-realtime.ts'), 'utf8');
  assert.match(src, /!hasProgressed && !closed\) next = 'connecting'/);
});
