import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { meanLuma } from '../src/lib/xmax-realtime.ts';

test('meanLuma separates black and lit frames', () => {
  assert.equal(meanLuma(new Uint8ClampedArray(16)), 0);
  assert.ok(meanLuma(new Uint8ClampedArray([200, 180, 160, 255, 90, 80, 70, 255])) > 12);
});

test('Plus uses the app-selected camera track, not the SDK default camera', () => {
  const src = fs.readFileSync(new URL('../src/lib/xmax-realtime.ts', import.meta.url), 'utf8');
  assert.match(src, /createExternalVideoStream\(\{\s*videoTrack: inputTrack/);
  assert.match(src, /isTrackBlack\(inputTrack\)/);
  const dash = fs.readFileSync(new URL('../src/pages/Dashboard.tsx', import.meta.url), 'utf8');
  assert.match(dash, /connectToXmax\(apiToken, initialTransform, stream\)/);
  assert.match(dash, /inputStream,/);
});
