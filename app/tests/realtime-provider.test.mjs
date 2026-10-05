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
  assert.match(dashboard, /getViduRealtimeUserMessage\(error, fallback\)/);
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
  assert.match(startSessionApi, /profileResult, activeSessionsResult, walletResult, recentTokenMints/);
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
