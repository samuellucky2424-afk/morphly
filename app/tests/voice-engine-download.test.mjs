import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { splitVoiceEngine } from '../scripts/split-voice-engine.mjs';
import { downloadVoiceEngineArchive, validateVoiceEngineManifest, VOICE_ENGINE_ASSET_NAME } from '../shared/voice-engine-archive.js';
import { getVoiceEngineReleaseBase } from '../electron/voice-engine-installer.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morphly-engine-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = Buffer.from('A voice engine archive divided into multiple parts.');
  const source = path.join(root, VOICE_ENGINE_ASSET_NAME);
  await fs.writeFile(source, original);
  const manifest = await splitVoiceEngine(source, 11);
  const destinationPath = path.join(root, 'assembled.zip');
  const requestStream = async (url) => Readable.from([await fs.readFile(path.join(root, new URL(url).pathname.split('/').at(-1)))]);
  return { root, original, manifest, destinationPath, requestStream, baseUrl: getVoiceEngineReleaseBase('2.5.6') };
}

test('published parts reassemble byte-for-byte with aggregate progress', async (t) => {
  const input = await fixture(t);
  const progress = [];
  await downloadVoiceEngineArchive({ ...input, onProgress: (event) => progress.push(event) });
  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
  assert.equal(input.manifest.parts.length, 5);
  assert.equal(progress.at(-1).phase, 'verifying');
  assert.equal(progress.at(-2).receivedBytes, input.original.length);
  assert.ok(progress.every((event, index) => index === 0 || event.percent >= progress[index - 1].percent));
});

for (const failure of ['corrupt', 'truncated', 'oversized', 'interrupted', 'missing', 'archive-checksum']) {
  test(`rejects ${failure} downloads and removes the partial ZIP`, async (t) => {
    const input = await fixture(t);
    const validRequest = input.requestStream;
    input.requestStream = async (url) => {
      if (failure === 'missing') throw new Error('HTTP 404');
      if (failure === 'interrupted') return Readable.from((async function* () {
        yield Buffer.from('A voice');
        throw new Error('Connection reset');
      })());
      const data = await fs.readFile(path.join(input.root, new URL(url).pathname.split('/').at(-1)));
      if (failure === 'corrupt') { data[0] ^= 0xff; return Readable.from([data]); }
      if (failure === 'truncated') return Readable.from([data.subarray(1)]);
      if (failure === 'oversized') return Readable.from([data, Buffer.from('extra')]);
      return validRequest(url);
    };
    if (failure === 'archive-checksum') input.manifest.sha256 = '0'.repeat(64);
    await assert.rejects(downloadVoiceEngineArchive(input));
    await assert.rejects(fs.access(input.destinationPath));
  });
}

test('manifest rejects unsafe names, missing checksums, oversized or reordered parts', async (t) => {
  const { manifest } = await fixture(t);
  for (const change of [
    (m) => { m.parts[0].name = '../outside.zip'; },
    (m) => { delete m.parts[0].sha256; },
    (m) => { m.parts[0].size = 2 ** 31; },
    (m) => { m.parts.reverse(); },
    (m) => { m.size++; },
    (m) => { m.parts = []; },
  ]) {
    const invalid = structuredClone(manifest);
    change(invalid);
    assert.throws(() => validateVoiceEngineManifest(invalid));
  }
});

test('engine downloads are pinned to the installed desktop version', () => {
  assert.equal(getVoiceEngineReleaseBase('2.5.6'), 'https://github.com/samuellucky2424-afk/morphly/releases/download/v2.5.6');
  assert.throws(() => getVoiceEngineReleaseBase('../latest'));
});
