import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDecartConnectInitialState,
  buildDecartSessionUpdate,
  shouldNormalizeDecartReference,
} from '../src/lib/decart-realtime.ts';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Decart connects in passthrough instead of sending transform state during the handshake', () => {
  assert.deepEqual(buildDecartConnectInitialState(), { passthrough: true });
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

test('the dashboard waits for decoded output and uses one clock for the freeze watchdog', () => {
  const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');

  assert.match(dashboard, /initialState: buildDecartConnectInitialState\(\)/);
  assert.match(dashboard, /await withTimeout\(\s*firstFramePromise/);
  assert.match(dashboard, /lastRemoteFrameAtRef\.current = Date\.now\(\)/);
  assert.doesNotMatch(dashboard, /lastRemoteFrameAtRef\.current = performance\.now\(\)/);
  assert.doesNotMatch(dashboard, /initialState:\s*\{\s*prompt:/);
});
