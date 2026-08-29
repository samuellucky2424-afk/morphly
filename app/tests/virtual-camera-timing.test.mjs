import test from 'node:test';
import assert from 'node:assert/strict';

import { getNextVirtualCameraFrameClock } from '../src/lib/virtual-camera-timing.ts';

test('a 30fps decoded stream is paced near 24fps without collapsing to 15fps', () => {
  const decodedFrameIntervalMs = 1000 / 30;
  const outputFrameIntervalMs = 1000 / 24;
  let lastFrameAt = -1;
  let framesPublished = 0;

  for (let frame = 0; frame < 30; frame += 1) {
    const now = frame * decodedFrameIntervalMs;
    const nextClock = getNextVirtualCameraFrameClock(lastFrameAt, now, outputFrameIntervalMs);
    if (nextClock !== null) {
      framesPublished += 1;
      lastFrameAt = nextClock;
    }
  }

  assert.ok(framesPublished >= 23 && framesPublished <= 25, `published ${framesPublished} frames`);
});

test('the pacing clock rejects early frames and carries fractional time forward', () => {
  const intervalMs = 1000 / 24;
  const firstClock = getNextVirtualCameraFrameClock(-1, 100, intervalMs);

  assert.equal(firstClock, 100);
  assert.equal(getNextVirtualCameraFrameClock(firstClock, 133, intervalMs), null);
  assert.ok(getNextVirtualCameraFrameClock(firstClock, 167, intervalMs) < 167);
});
