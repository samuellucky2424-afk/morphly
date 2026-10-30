import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSofteningPlan, normalizeXmaxReferenceSoftening, XMAX_REFERENCE_SOFTENING_DEFAULTS } from '../src/lib/xmax-reference-softening.ts';
import { readXmaxReferenceSoftening } from '../server/api/start-session.ts';

test('Plus reference defaults: soft, slightly dim selfie', () => {
  assert.deepEqual(XMAX_REFERENCE_SOFTENING_DEFAULTS, { maxSide: 512, downscale: 0.75, blurPercent: 0.5, brightness: 0.94, contrast: 0.92, quality: 0.9 });
  const plan = computeSofteningPlan(2048, 1536, normalizeXmaxReferenceSoftening());
  assert.equal(plan.outWidth, 512); assert.equal(plan.outHeight, 384); assert.equal(plan.smallWidth, 384);
  assert.equal(plan.filter, 'blur(1.92px) brightness(0.94) contrast(0.92)');
});

test('overrides are clamped; server only forwards set env values', () => {
  assert.equal(normalizeXmaxReferenceSoftening({ blurPercent: 99, contrast: Number.NaN }).blurPercent, 5);
  assert.equal(normalizeXmaxReferenceSoftening({ contrast: Number.NaN }).contrast, 0.92);
  assert.deepEqual(readXmaxReferenceSoftening({}), {});
  assert.deepEqual(readXmaxReferenceSoftening({ XMAX_REFERENCE_BLUR_PERCENT: '1', XMAX_REFERENCE_BRIGHTNESS: 'x' }), { blurPercent: 1 });
});
