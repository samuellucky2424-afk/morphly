import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSofteningPlan, normalizeXmaxReferenceSoftening } from '../src/lib/xmax-reference-softening.ts';
import { readXmaxReferenceSoftening } from '../server/api/start-session.ts';

test('Xmax reference softening downscales to 512 and blurs ~1.5% of shorter side', () => {
  const plan = computeSofteningPlan(2048, 1536, normalizeXmaxReferenceSoftening());
  assert.deepEqual(plan, { outWidth: 512, outHeight: 384, blurPx: 5.76 });
  assert.equal(computeSofteningPlan(300, 200, normalizeXmaxReferenceSoftening()).outWidth, 300);
});

test('server softening config defaults and env overrides are clamped', () => {
  assert.deepEqual(readXmaxReferenceSoftening({}), { blurPercent: 1.5, maxSide: 512, quality: 0.9 });
  assert.deepEqual(readXmaxReferenceSoftening({ XMAX_REFERENCE_BLUR_PERCENT: '0', XMAX_REFERENCE_MAX_SIDE: '768' }), { blurPercent: 0, maxSide: 768, quality: 0.9 });
  assert.equal(readXmaxReferenceSoftening({ XMAX_REFERENCE_BLUR_PERCENT: 'abc' }).blurPercent, 1.5);
  assert.equal(readXmaxReferenceSoftening({ XMAX_REFERENCE_BLUR_PERCENT: '99' }).blurPercent, 10);
});
