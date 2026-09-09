import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_PRESETS, buildRealtimeTransformPrompt } from '../src/lib/background-presets.ts';
import { XMAX_VIBEX_PROMPT } from '../src/lib/xmax-realtime.ts';

for (const preset of BACKGROUND_PRESETS) {
  test(`Plus uses the reference as a style image for ${preset.id}`, () => {
    const prompt = buildRealtimeTransformPrompt('xmax', true, preset.id);
    assert.ok(prompt.startsWith(XMAX_VIBEX_PROMPT));
    assert.doesNotMatch(prompt, /substitute|replace only the person|preserve the reference person's identity/i);
    if (preset.prompt) assert.ok(prompt.includes(preset.prompt));
  });

  test(`Pro uses the reference as an avatar for ${preset.id}`, () => {
    const prompt = buildRealtimeTransformPrompt('decart', true, preset.id);
    assert.ok(prompt.startsWith(preset.avatarPrompt));
    assert.match(prompt, /Preserve the reference person's identity/);
    assert.doesNotMatch(prompt, /restyle|selected visual aesthetic/i);
  });
}

test('custom backgrounds retain the selected mode and trim the background prefix', () => {
  const custom = '  Change the background to a library  ';
  const plus = buildRealtimeTransformPrompt('xmax', true, 'original', custom);
  const pro = buildRealtimeTransformPrompt('decart', true, 'original', custom);
  assert.ok(plus.startsWith(XMAX_VIBEX_PROMPT));
  assert.match(plus, /Change the background to a library\./);
  assert.doesNotMatch(plus, /replace only|identity/i);
  assert.match(pro, /Replace only the person in the video with the person in the reference image/);
  assert.match(pro, /Change the background to a library,/);
  assert.doesNotMatch(pro, /restyle/i);
});

test('Pro without an image preserves the camera or applies only the background', () => {
  assert.match(buildRealtimeTransformPrompt('decart', false, 'original'), /^Preserve the person/);
  for (const provider of ['xmax', 'decart']) {
    for (const preset of BACKGROUND_PRESETS.slice(1)) {
      assert.equal(buildRealtimeTransformPrompt(provider, false, preset.id), preset.prompt);
    }
    const custom = buildRealtimeTransformPrompt(provider, false, 'original', 'a library');
    assert.match(custom, /^Change the background to a library/);
    assert.doesNotMatch(custom, /reference image|substitute|replace only/i);
  }
});

test('switching modes selects distinct defaults, including unknown presets', () => {
  for (const preset of ['original', 'unknown']) {
    assert.equal(buildRealtimeTransformPrompt('xmax', true, preset), XMAX_VIBEX_PROMPT);
    assert.match(buildRealtimeTransformPrompt('decart', true, preset), /^Substitute the character/);
  }
});
