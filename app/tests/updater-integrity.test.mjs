import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getDownloadSizeError,
  verifyUpdateFile
} from '../electron/update-integrity.js';
import { resolveVersionManifest } from '../../shared/version-manifest-handler.js';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempFile(contents, callback) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'morphly-updater-'));
  const filePath = path.join(directory, 'Morphly-Setup-test.exe');
  try {
    await fs.promises.writeFile(filePath, contents);
    await callback(filePath);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

test('cached installers without integrity metadata are never trusted', async () => {
  await withTempFile('partial installer', async (filePath) => {
    const result = await verifyUpdateFile(filePath);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'missing-integrity-metadata');
  });
});

test('cached installers must match both the published size and checksum', async () => {
  const contents = Buffer.from('complete installer');
  const checksum = crypto.createHash('sha256').update(contents).digest('hex');

  await withTempFile(contents, async (filePath) => {
    const valid = await verifyUpdateFile(filePath, {
      expectedSize: contents.length,
      checksum: `sha256:${checksum}`
    });
    assert.equal(valid.valid, true);
    assert.equal(valid.checksumVerified, true);

    const wrongSize = await verifyUpdateFile(filePath, {
      expectedSize: contents.length + 1,
      checksum
    });
    assert.equal(wrongSize.valid, false);
    assert.equal(wrongSize.reason, 'size-mismatch');

    const wrongChecksum = await verifyUpdateFile(filePath, {
      expectedSize: contents.length,
      checksum: '0'.repeat(64)
    });
    assert.equal(wrongChecksum.valid, false);
    assert.equal(wrongChecksum.reason, 'checksum-mismatch');
  });
});

test('incomplete response bodies are rejected even without a checksum', () => {
  assert.match(getDownloadSizeError(80, null, 100), /received 80 of 100 bytes/);
  assert.equal(getDownloadSizeError(100, null, 100), null);
  assert.match(getDownloadSizeError(100, 120, 100), /metadata mismatch/);
});

test('version manifest includes GitHub asset digest and byte size', async () => {
  const originalFetch = globalThis.fetch;
  const digest = `sha256:${'a'.repeat(64)}`;

  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        tag_name: 'v2.1.9',
        body: 'Release notes',
        assets: [{
          name: 'Morphly-Setup-2.1.9.exe',
          size: 113_214_505,
          digest
        }]
      };
    }
  });

  try {
    const manifest = await resolveVersionManifest({ query: { build: 'installer' } }, { env: {} });
    assert.equal(manifest.checksum, digest);
    assert.equal(manifest.expectedSize, 113_214_505);
    assert.match(manifest.downloadUrl, /Morphly-Setup-2\.1\.9\.exe$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('desktop updater stages downloads and verifies again before launch', () => {
  const source = fs.readFileSync(path.join(appDirectory, 'electron/updater.js'), 'utf8');
  const partialWrite = source.indexOf("fs.createWriteStream(partialDestination, { flags: 'wx' })");
  const finalRename = source.indexOf('fs.renameSync(partialDestination, destination)');
  const preLaunchVerification = source.lastIndexOf('await verifyUpdateFile(downloadedPath');
  const installerLaunch = source.indexOf('await shell.openPath(state.downloadedPath)');

  assert.ok(partialWrite >= 0);
  assert.ok(finalRename > partialWrite);
  assert.ok(preLaunchVerification >= 0);
  assert.ok(installerLaunch > preLaunchVerification);
});
