import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { models } from '@decartai/sdk';

import {
  DECART_REALTIME_MODEL,
  DECART_REALTIME_RESOLUTION,
  buildDecartConnectInitialState,
  buildDecartSessionUpdate,
  getDecartRealtimeUserMessage,
  shouldNormalizeDecartReference,
} from '../src/lib/decart-realtime.ts';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Decart connects in passthrough instead of sending transform state during the handshake', () => {
  assert.deepEqual(buildDecartConnectInitialState(), { passthrough: true });
});

test('Decart realtime uses Lucy 2.5 with an explicit 720p output request', () => {
  assert.equal(DECART_REALTIME_MODEL, 'lucy-2.5');
  assert.equal(DECART_REALTIME_RESOLUTION, '720p');
  const model = models.realtime(DECART_REALTIME_MODEL);
  assert.equal(model.width, 1280);
  assert.equal(model.height, 720);
  assert.deepEqual(model.fps, { ideal: 30, max: 30 });
});

test('an empty Original transform never sends an invalid empty prompt', () => {
  assert.equal(buildDecartSessionUpdate({
    prompt: '   ',
    enhance: true,
    image: null,
  }), null);
});

test('a requested transform is sent atomically after the media connection is ready', () => {
  const image = new Blob(['reference'], { type: 'image/jpeg' });

  assert.deepEqual(buildDecartSessionUpdate({
    prompt: '  Transform into this character  ',
    enhance: true,
    image,
  }), {
    prompt: 'Transform into this character',
    enhance: true,
    image,
  });
});

test('large, oversized-dimension, and unsupported reference images are normalized', () => {
  assert.equal(shouldNormalizeDecartReference({ type: 'image/jpeg', size: 1024 }, 1024, 1024), false);
  assert.equal(shouldNormalizeDecartReference({ type: 'image/jpeg', size: 6 * 1024 * 1024 }, 1024, 1024), true);
  assert.equal(shouldNormalizeDecartReference({ type: 'image/png', size: 1024 }, 3000, 1200), true);
  assert.equal(shouldNormalizeDecartReference({ type: 'image/gif', size: 1024 }, 1024, 1024), true);
});

test('Decart moderation and connection failures produce useful user messages', () => {
  assert.match(
    getDecartRealtimeUserMessage({ message: 'Request rejected by moderation' }),
    /not accepted/i,
  );
  assert.match(
    getDecartRealtimeUserMessage({ code: 'WEB_RTC_ERROR', message: 'socket failed' }),
    /trying to recover/i,
  );
});

test('the dashboard waits for decoded output and uses one clock for the freeze watchdog', () => {
  const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');

  assert.match(dashboard, /initialState: buildDecartConnectInitialState\(\)/);
  assert.match(dashboard, /mirror: 'auto'/);
  assert.match(dashboard, /resolution: DECART_REALTIME_RESOLUTION/);
  assert.match(dashboard, /realtimeClient\.on\('connectionQuality'/);
  assert.match(dashboard, /realtimeClient\.on\('error'/);
  assert.match(dashboard, /await withTimeout\(\s*firstFramePromise/);
  assert.match(dashboard, /lastRemoteFrameAtRef\.current = Date\.now\(\)/);
  assert.doesNotMatch(dashboard, /lastRemoteFrameAtRef\.current = performance\.now\(\)/);
  assert.doesNotMatch(dashboard, /initialState:\s*\{\s*prompt:/);
});
