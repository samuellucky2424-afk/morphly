import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  XMAX_PASSTHROUGH_PROMPT,
  XMAX_REALTIME_MODEL,
  buildXmaxRealtimeContext,
  getXmaxRealtimeUserMessage,
  shouldNormalizeXmaxReference,
} from '../src/lib/xmax-realtime.ts';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');

test('Xmax realtime uses the documented X2.0 model', () => {
  assert.equal(XMAX_REALTIME_MODEL, 'x2.0');
});

test('an empty Original transform receives a valid preservation prompt', () => {
  assert.deepEqual(buildXmaxRealtimeContext({
    prompt: '   ',
    image: null,
  }), {
    prompt: XMAX_PASSTHROUGH_PROMPT,
    refImageUrl: null,
  });
});

test('a prompt and uploaded reference URL are sent atomically', () => {
  const image = new Blob(['reference'], { type: 'image/jpeg' });

  assert.deepEqual(buildXmaxRealtimeContext({
    prompt: '  Transform into this character  ',
    image,
  }, 'https://cdn.example/reference.jpg'), {
    prompt: 'Transform into this character',
    refImageUrl: 'https://cdn.example/reference.jpg',
  });
});

test('large, oversized-dimension, and unsupported reference images are normalized', () => {
  assert.equal(shouldNormalizeXmaxReference({ type: 'image/jpeg', size: 1024 }, 1024, 1024), false);
  assert.equal(shouldNormalizeXmaxReference({ type: 'image/jpeg', size: 6 * 1024 * 1024 }, 1024, 1024), true);
  assert.equal(shouldNormalizeXmaxReference({ type: 'image/png', size: 1024 }, 3000, 1200), true);
  assert.equal(shouldNormalizeXmaxReference({ type: 'image/gif', size: 1024 }, 1024, 1024), true);
});

test('Xmax moderation and connection failures produce useful user messages', () => {
  assert.match(
    getXmaxRealtimeUserMessage({ message: 'Request rejected by moderation' }),
    /not accepted/i,
  );
  assert.match(
    getXmaxRealtimeUserMessage({ code: 'WEB_RTC_ERROR', message: 'socket failed' }),
    /trying to recover/i,
  );
});

test('the dashboard keeps Xmax checked uploads, X2 context, and explicit 720p streaming', () => {
  const viteConfig = fs.readFileSync(path.join(appDirectory, 'vite.config.ts'), 'utf8');

  assert.match(dashboard, /import\('@xmaxai\/sdk-global'\)/);
  assert.match(dashboard, /@\/lib\/background-presets/);
  assert.doesNotMatch(dashboard, /@\/components\/BackgroundReplacer/);
  assert.match(dashboard, /client\.files\.uploadAndCheckImage\(transform\.image\)/);
  assert.match(dashboard, /context: initialContext/);
  assert.doesNotMatch(dashboard, /resolveDefaultCameraRealtimeSetting/);
  assert.match(dashboard, /width: qualityProfile\.width/);
  assert.match(dashboard, /height: qualityProfile\.height/);
  assert.match(dashboard, /stream: streamSetting/);
  assert.doesNotMatch(dashboard, /getAdaptiveQualityMode/);
  assert.match(dashboard, /id="output"[\s\S]*className="h-full w-full object-contain/);
  assert.match(dashboard, /transform: 'translateZ\(0\) scaleX\(-1\)'/);
  assert.match(dashboard, /onRemoteVideoFirstFrame: \(info\)/);
  assert.match(dashboard, /remote output received: \$\{info\.width\}x\$\{info\.height\}/);
  assert.match(dashboard, /Live output/);
  assert.doesNotMatch(dashboard, /Xmax output\s*1280\s*[x×]\s*720/i);
  assert.match(dashboard, /onStateChange:/);
  assert.match(dashboard, /await withTimeout\(\s*firstFramePromise/);
  assert.match(dashboard, /lastRemoteFrameAtRef\.current = Date\.now\(\)/);
  assert.match(dashboard, /import\('@decartai\/sdk'\)/);
  assert.doesNotMatch(viteConfig, /optimizeDeps[\s\S]*@decartai\/sdk/);
});

test('unexpected Xmax disconnects recover without closing the virtual-camera output', () => {
  assert.match(dashboard, /restartRealtimeSessionRef\.current\?\.\(`xmax-disconnect-\$\{reason\}`\)/);
  assert.match(dashboard, /retry-after-failed-restart/);
  assert.match(dashboard, /if \(options\?\.skipStateUpdate\)[\s\S]*updateMorphlyCamStatus\('Reconnecting Morphly cam\.\.\.'\)/);
});
