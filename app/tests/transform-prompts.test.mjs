import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_PRESETS, buildRealtimeTransformPrompt } from '../src/lib/background-presets.ts';

test('Lucy 2.5 gets the exact requested reference prompt for the original background', () => {
  for (const preset of ['original', 'unknown']) {
    assert.equal(buildRealtimeTransformPrompt('decart', true, preset), 'Turn the person into the reference image');
  }
});
test('Lucy retains the reference instruction when a background is selected', () => {
  for (const preset of BACKGROUND_PRESETS.slice(1)) {
    assert.equal(buildRealtimeTransformPrompt('decart', true, preset.id), `Turn the person into the reference image. ${preset.prompt}`);
    assert.equal(buildRealtimeTransformPrompt('decart', false, preset.id), preset.prompt);
  }
  assert.equal(buildRealtimeTransformPrompt('decart', true, 'original', '  Change the background to a library  '),
    'Turn the person into the reference image. Change the background to a library.');
  assert.equal(buildRealtimeTransformPrompt('decart', false, 'original', 'a library'), 'Change the background to a library.');
});
test('Vidu remains a distinct subject replacement engine', () => {
  assert.match(buildRealtimeTransformPrompt('vidu', true, 'original'), /^Substitute the character/);
});
