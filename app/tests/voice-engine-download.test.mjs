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

test('resumes partially downloaded archive and verifies full checksum', async (t) => {
  const input = await fixture(t);
  // Pre-write first 20 bytes (out of 51 bytes in input.original) to destinationPath
  const partialBytes = 20;
  await fs.writeFile(input.destinationPath, input.original.subarray(0, partialBytes));

  const requestedRanges = [];
  input.requestStream = async (url, options = {}) => {
    const filename = new URL(url).pathname.split('/').at(-1);
    const data = await fs.readFile(path.join(input.root, filename));
    const startByte = options.startByte || 0;
    requestedRanges.push({ filename, startByte });
    return Readable.from([data.subarray(startByte)]);
  };

  const progress = [];
  await downloadVoiceEngineArchive({
    ...input,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
  assert.ok(requestedRanges.some((r) => r.startByte > 0), 'Should have requested Range starting from existing bytes');
  assert.equal(progress.at(-1).phase, 'verifying');
});

test('auto-retries and resumes without restarting from the beginning when connection is interrupted', async (t) => {
  const input = await fixture(t);
  let failedOnce = false;

  input.requestStream = async (url, options = {}) => {
    const filename = new URL(url).pathname.split('/').at(-1);
    const data = await fs.readFile(path.join(input.root, filename));
    const startByte = options.startByte || 0;

    // Simulate network interruption midway through part 2
    if (!failedOnce && filename.endsWith('part-002') && startByte === 0) {
      failedOnce = true;
      return Readable.from((async function* () {
        yield data.subarray(0, 5); // Deliver 5 bytes, then drop connection
        throw new Error('Connection reset by peer');
      })());
    }

    return Readable.from([data.subarray(startByte)]);
  };

  const progress = [];
  await downloadVoiceEngineArchive({
    ...input,
    maxRetries: 3,
    initialRetryDelayMs: 10,
    maxRetryDelayMs: 50,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
  assert.equal(failedOnce, true);
  assert.ok(progress.some((p) => p.retrying === true), 'Should report retrying on network error');
});


test('short responses keep their downloaded bytes and resume at the exact offset', async t => {
  const input = await fixture(t);
  const ranges = [];
  let shortened = false;
  input.requestStream = async (url, options = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    const data = await fs.readFile(path.join(input.root, name));
    const start = options.startByte || 0;
    ranges.push([name, start]);
    if (!shortened) { shortened = true; return Readable.from([data.subarray(0, 4)]); }
    return Readable.from([data.subarray(start)]);
  };
  await downloadVoiceEngineArchive({ ...input, maxRetries: 3, initialRetryDelayMs: 1 });
  assert.equal(ranges[1][1], 4);
  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
});

test('a completed archive needs no network requests after restarting the app', async t => {
  const input = await fixture(t);
  await fs.writeFile(input.destinationPath, input.original);
  await downloadVoiceEngineArchive({ ...input, requestStream: () => assert.fail('already complete') });
  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
});

test('saved archive verification repairs a corrupt part without polluting the aggregate checksum', async t => {
  const input = await fixture(t);
  const corrupted = Buffer.from(input.original);
  corrupted[12] ^= 0xff;
  await fs.writeFile(input.destinationPath, corrupted);
  await downloadVoiceEngineArchive(input);
  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
});

test('saved partial bytes survive failure and a new downloader invocation resumes them', async t => {
  const input = await fixture(t);
  await fs.writeFile(input.destinationPath, input.original.subarray(0, 4));
  await assert.rejects(downloadVoiceEngineArchive({ ...input, cleanOnFailure: false, requestStream: async () => { throw new Error('offline'); } }));
  assert.equal((await fs.stat(input.destinationPath)).size, 4);
  let firstStart;
  await downloadVoiceEngineArchive({ ...input, requestStream: async (url, options) => {
    firstStart ??= options.startByte;
    const data = await fs.readFile(path.join(input.root, new URL(url).pathname.split('/').at(-1)));
    const response = Readable.from([data.subarray(options.startByte)]);
    response.statusCode = options.startByte ? 206 : 200;
    response.headers = { 'content-range': `bytes ${options.startByte}-${data.length - 1}/${data.length}` };
    return response;
  } });
  assert.equal(firstStart, 4);
  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
});

test('servers ignoring Range restart only the current part, preserving verified parts', async t => {
  const input = await fixture(t);
  await fs.writeFile(input.destinationPath, input.original.subarray(0, 15));
  const names = [];
  await downloadVoiceEngineArchive({ ...input, requestStream: async url => {
    const name = new URL(url).pathname.split('/').at(-1); names.push(name);
    const response = Readable.from([await fs.readFile(path.join(input.root, name))]);
    response.statusCode = 200;
    return response;
  } });
  assert.ok(names[0].endsWith('part-002'));
  assert.deepEqual(await fs.readFile(input.destinationPath), input.original);
});

test('incorrect Content-Range is rejected before saved bytes are modified', async t => {
  const input = await fixture(t);
  await fs.writeFile(input.destinationPath, input.original.subarray(0, 4));
  await assert.rejects(downloadVoiceEngineArchive({ ...input, cleanOnFailure: false, maxRetries: Infinity, requestStream: async () => {
    const response = Readable.from([Buffer.from('wrong')]);
    response.statusCode = 206; response.headers = { 'content-range': 'bytes 0-10/11' };
    return response;
  } }), /invalid byte range/);
  assert.equal((await fs.stat(input.destinationPath)).size, 4);
});

test('temporary failures retry beyond the previous cap; permanent and disk errors stop', async () => {
  const { retryDownload } = await import('../shared/download-retry.js');
  let calls = 0;
  const result = await retryDownload(async () => { if (++calls < 105) throw new Error('offline'); return 'done'; }, { wait: async () => {} });
  assert.equal(result, 'done'); assert.equal(calls, 105);
  for (const error of [Object.assign(new Error('missing asset'), { statusCode: 404 }), Object.assign(new Error('disk full'), { code: 'ENOSPC' })]) {
    await assert.rejects(retryDownload(async () => { throw error; }, { wait: () => assert.fail('must not retry') }));
  }
});
