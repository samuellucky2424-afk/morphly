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

test('Vidu is the only available realtime provider', () => {
  assert.equal(DEFAULT_REALTIME_PROVIDER, 'vidu');
  assert.deepEqual(REALTIME_PROVIDER_OPTIONS.map(({ value }) => value), ['vidu']);
  assert.deepEqual(REALTIME_PROVIDER_OPTIONS.map(({ label }) => label), ['Plus']);
  assert.equal(getRealtimeProviderLabel('vidu'), 'Plus');
  assert.equal(getRealtimeProviderLabel('decart'), 'Pro');
  assert.equal(resolveRealtimeProvider(undefined), 'vidu');
  assert.equal(resolveRealtimeProvider('vidu'), 'vidu');
  assert.equal(resolveRealtimeProvider('decart'), 'vidu');
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
  assert.match(rtc, /Plus could not connect/);
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
