import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECART_REALTIME_MODEL,
  DEFAULT_REALTIME_PROVIDER,
  REALTIME_PROVIDER_OPTIONS,
  getDecartRealtimeUserMessage,
  getRealtimeProviderLabel,
  resolveRealtimeModel,
  resolveRealtimeProvider,
} from '../src/lib/realtime-provider.ts';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
const appShell = fs.readFileSync(path.join(appDirectory, 'src/App.tsx'), 'utf8');
const startSessionApi = fs.readFileSync(path.join(appDirectory, 'server/api/start-session.ts'), 'utf8');

test('Xmax is the default and both realtime providers are available', () => {
  assert.equal(DEFAULT_REALTIME_PROVIDER, 'xmax');
  assert.deepEqual(REALTIME_PROVIDER_OPTIONS.map(({ value }) => value), ['xmax', 'decart']);
  assert.deepEqual(REALTIME_PROVIDER_OPTIONS.map(({ label }) => label), ['Plus', 'Pro']);
  assert.equal(getRealtimeProviderLabel('xmax'), 'Plus');
  assert.equal(getRealtimeProviderLabel('decart'), 'Pro');
  assert.equal(resolveRealtimeProvider(undefined), 'xmax');
  assert.equal(resolveRealtimeProvider('decart'), 'decart');
});

test('Decart uses the native 720p Lucy 2.5 character model', () => {
  assert.equal(DECART_REALTIME_MODEL, 'lucy-2.5');
  assert.equal(resolveRealtimeModel('decart', 'lucy-2.5'), 'lucy-2.5');
  assert.equal(resolveRealtimeModel('decart', 'invalid'), 'lucy-2.5');
});

test('Decart realtime errors provide actionable user messages', () => {
  assert.match(getDecartRealtimeUserMessage({ message: 'Rejected by moderation' }), /Pro did not accept/i);
  assert.match(getDecartRealtimeUserMessage({ message: 'Insufficient credits' }), /provider capacity is exhausted/i);
  assert.match(getDecartRealtimeUserMessage({ code: 'WEBRTC_ERROR' }), /Pro connection was interrupted/i);
  assert.match(dashboard, /provider === DECART_REALTIME_PROVIDER[\s\S]*getDecartRealtimeUserMessage\(error, fallback\)/);
});

test('dashboard exposes a compact provider switch and locks it during active sessions', () => {
  assert.match(dashboard, /data-testid="realtime-provider-selector"/);
  assert.match(dashboard, /value=\{selectedProvider\}/);
  assert.match(dashboard, /disabled=\{isLoading \|\| isStreaming\}/);
  assert.match(dashboard, /provider: requestedProvider/);
  assert.match(dashboard, /connectToRealtimeProvider/);
  assert.match(dashboard, /mirror: 'auto'/);
  assert.match(dashboard, /resolution: '720p'/);
  assert.match(dashboard, /realtimeSession\.set\(\{/);
  assert.doesNotMatch(dashboard, /initialState,/);
  assert.match(dashboard, /Promise\.race\(\[initialUpdatePromise, firstFramePromise\]\)/);
  assert.match(dashboard, /HD 720p/);
  assert.match(dashboard, /const PRO_CAMERA_FPS = 30/);
  assert.match(dashboard, /buildProviderVideoInputConstraints\(attemptedMode, provider/);
});

test('Decart token creation retries transient failures and preserves the SDK HTTP status', () => {
  assert.match(startSessionApi, /DECART_TOKEN_MAX_ATTEMPTS = 2/);
  assert.match(startSessionApi, /error\?\.data\?\.status/);
  assert.match(startSessionApi, /providerStatus === 429/);
  assert.match(startSessionApi, /providerStatus >= 500/);
});

test('startup avoids stacked retries and reports each connection phase', () => {
  assert.match(dashboard, /xmax: 2,[\s\S]*decart: 1/);
  assert.match(dashboard, /xmax: 30000,[\s\S]*decart: 45000/);
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
