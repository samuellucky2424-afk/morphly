import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationAudioQueue } from '../shared/translation-audio-queue.js';
import { issueHandoff, verifyHandoff } from '../server/translation-handoff.js';

test('recovery queue retains at most two seconds per direction in chronological order', () => {
  const queue = createTranslationAudioQueue();
  for (let i = 0; i < 30; i++) for (const direction of ['outgoing', 'incoming']) {
    queue.push({ type: 'audio', direction, data: Buffer.alloc(3200, i).toString('base64') });
  }
  assert.equal(queue.length, 40);
  for (let i = 10; i < 30; i++) for (const direction of ['outgoing', 'incoming']) {
    const entry = queue.shift();
    assert.equal(entry.message.direction, direction);
    assert.equal(Buffer.from(entry.message.data, 'base64')[0], i);
  }
  assert.equal(queue.shift(), undefined);
});

test('expired microphone audio is not replayed after long outages; Stop clears all retained audio', () => {
  let clock = 0;
  const queue = createTranslationAudioQueue({ now: () => clock });
  queue.push({ type: 'audio', direction: 'outgoing', data: 'AAAAAA==' });
  clock = 2001;
  assert.equal(queue.length, 0);
  queue.push({ type: 'audio', direction: 'incoming', data: 'AAAAAA==' });
  queue.clear();
  assert.equal(queue.shift(), undefined);
});

test('handoff tickets cannot cross users, languages, directions, signing keys, or expiry', () => {
  const claims = { userId: 'user-a', targetLanguage: 'es', incoming: true };
  const ticket = issueHandoff('test-secret', claims, 1000);
  assert.equal(verifyHandoff('test-secret', ticket, claims, 2000), true);
  assert.equal(verifyHandoff('test-secret', ticket, claims, 31000), false);
  assert.equal(verifyHandoff('other-key', ticket, claims, 2000), false);
  assert.equal(verifyHandoff('test-secret', ticket + 'tampered', claims, 2000), false);
  for (const patch of [{ userId: 'user-b' }, { targetLanguage: 'fr' }, { incoming: false }]) {
    assert.equal(verifyHandoff('test-secret', ticket, { ...claims, ...patch }, 2000), false);
  }
});
