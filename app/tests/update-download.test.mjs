import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadUpdateFile } from '../electron/update-download.js';

const payload = Buffer.from('morphly-installer-test-data-'.repeat(1024));
const checksum = crypto.createHash('sha256').update(payload).digest('hex');

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morphly-download-test-'));
  const destination = path.join(root, 'setup.exe');
  const options = { destination, url: 'https://example.invalid/setup.exe', checksum,
    expectedSize: payload.length, retryDelayMs: 1, checkDiskSpace: false };
  try { await fn(options); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function brokenResponse(bytes = 128) {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent) controller.error(new Error('connection reset'));
      else { sent = true; controller.enqueue(payload.subarray(0, bytes)); }
    },
  }), { headers: { 'Content-Length': String(payload.length), ETag: '"v1"' } });
}

function remainder(headers, startOverride) {
  const offset = Number(headers.Range?.match(/bytes=(\d+)-/)?.[1] || 0);
  return new Response(payload.subarray(offset), { status: offset ? 206 : 200, headers: {
    'Content-Length': String(payload.length - offset), ETag: '"v1"',
    ...(offset ? { 'Content-Range': `bytes ${startOverride ?? offset}-${payload.length - 1}/${payload.length}` } : {}),
  } });
}

test('network retry resumes the saved bytes and verifies the entire installer', async () => fixture(async options => {
  const requests = [];
  const result = await downloadUpdateFile({ ...options, fetchImpl: async (_url, { headers }) => {
    requests.push(headers);
    return requests.length === 1 ? brokenResponse() : remainder(headers);
  } });
  assert.equal(requests[1].Range, 'bytes=128-');
  assert.equal(requests[1]['If-Range'], '"v1"');
  assert.equal(result.checksumVerified, true);
  assert.deepEqual(await fs.readFile(options.destination), payload);
  await assert.rejects(fs.stat(`${options.destination}.part`), { code: 'ENOENT' });
}));

test('retry after an app restart preserves partial bytes and closes the previous writer', async () => fixture(async options => {
  await assert.rejects(downloadUpdateFile({ ...options, maxAttempts: 1, fetchImpl: async () => brokenResponse(256) }), /progress is saved/);
  assert.equal((await fs.stat(`${options.destination}.part`)).size, 256);
  const result = await downloadUpdateFile({ ...options, fetchImpl: async (_url, { headers }) => {
    assert.equal(headers.Range, 'bytes=256-');
    return remainder(headers);
  } });
  assert.equal(result.checksumVerified, true);
}));

test('server ignoring Range safely restarts instead of appending a second installer', async () => fixture(async options => {
  let calls = 0;
  await downloadUpdateFile({ ...options, fetchImpl: async () => ++calls === 1 ? brokenResponse() : new Response(payload) });
  assert.deepEqual(await fs.readFile(options.destination), payload);
}));

test('mismatched content ranges are rejected and cannot become installable', async () => fixture(async options => {
  let calls = 0;
  await assert.rejects(downloadUpdateFile({ ...options, fetchImpl: async (_url, { headers }) => {
    return ++calls === 1 ? brokenResponse() : remainder(headers, 12);
  } }), /invalid download range/);
  await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${options.destination}.part`), { code: 'ENOENT' });
}));

test('changed release metadata discards partial bytes before resuming', async () => fixture(async options => {
  await assert.rejects(downloadUpdateFile({ ...options, maxAttempts: 1, fetchImpl: async () => brokenResponse() }));
  await downloadUpdateFile({ ...options, url: 'https://example.invalid/new.exe', fetchImpl: async (_url, { headers }) => {
    assert.equal(headers.Range, undefined);
    return remainder(headers);
  } });
}));

test('checksum mismatch is never promoted, including after a resumed download', async () => fixture(async options => {
  let calls = 0;
  await assert.rejects(downloadUpdateFile({ ...options, checksum: '0'.repeat(64), fetchImpl: async (_url, { headers }) => {
    return ++calls === 1 ? brokenResponse() : remainder(headers);
  } }), /checksum-mismatch/);
  await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${options.destination}.part`), { code: 'ENOENT' });
}));

test('HTTP authentication errors are not retried repeatedly', async () => fixture(async options => {
  let calls = 0;
  await assert.rejects(downloadUpdateFile({ ...options, fetchImpl: async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  } }), /HTTP 401/);
  assert.equal(calls, 1);
}));

test('cancellation closes the partial file and a later call resumes it', async () => fixture(async options => {
  const controller = new AbortController();
  await assert.rejects(downloadUpdateFile({ ...options, signal: controller.signal,
    onProgress() { controller.abort(new Error('app closed')); },
    fetchImpl: async () => brokenResponse(512),
  }), /app closed/);
  assert.equal((await fs.stat(`${options.destination}.part`)).size, 512);
  await downloadUpdateFile({ ...options, fetchImpl: async (_url, { headers }) => {
    assert.equal(headers.Range, 'bytes=512-');
    return remainder(headers);
  } });
}));

test('a fully saved partial installer is verified without downloading again', async () => fixture(async options => {
  const identity = JSON.stringify([options.url, options.checksum, options.expectedSize]);
  await fs.writeFile(`${options.destination}.part`, payload);
  await fs.writeFile(`${options.destination}.part.json`, JSON.stringify({ identity, total: payload.length }));
  const result = await downloadUpdateFile({ ...options, fetchImpl: () => assert.fail('already complete') });
  assert.equal(result.checksumVerified, true);
}));

test('no-digest downloads require a stable strong ETag before combining responses', async () => fixture(async options => {
  let calls = 0;
  await assert.rejects(downloadUpdateFile({ ...options, checksum: null, fetchImpl: async (_url, { headers }) => {
    if (++calls === 1) return brokenResponse();
    const response = remainder(headers);
    response.headers.set('ETag', '"changed"');
    return response;
  } }), /update changed/);
  await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
}));

test('a real HTTP transfer can run longer than the idle timeout while making progress', async () => fixture(async options => {
  const server = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'Content-Length': payload.length });
    for (let i = 0; i < 8; i += 1) {
      response.write(payload.subarray(i * payload.length / 8, (i + 1) * payload.length / 8));
      await delay(50);
    }
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await downloadUpdateFile({ ...options, idleTimeoutMs: 200,
      url: `http://127.0.0.1:${server.address().port}/setup.exe` });
    assert.equal(result.checksumVerified, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('a stalled real HTTP connection times out, retains progress and can resume', async () => fixture(async options => {
  let resume = false;
  const server = http.createServer((request, response) => {
    if (!resume) {
      response.writeHead(200, { 'Content-Length': payload.length, ETag: '"v1"' });
      response.write(payload.subarray(0, 128));
    } else {
      assert.equal(request.headers.range, 'bytes=128-');
      response.writeHead(206, { 'Content-Length': payload.length - 128,
        'Content-Range': `bytes 128-${payload.length - 1}/${payload.length}`, ETag: '"v1"' });
      response.end(payload.subarray(128));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = { ...options, url: `http://127.0.0.1:${server.address().port}/setup.exe`, idleTimeoutMs: 150, maxAttempts: 1 };
  try {
    await assert.rejects(downloadUpdateFile(args), /progress is saved/);
    resume = true;
    assert.equal((await downloadUpdateFile(args)).checksumVerified, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));
