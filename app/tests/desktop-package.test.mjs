import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar');
const { verifyPackage } = require('../build/verify-package.cjs');

async function fixture(t, entries = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'morphly-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(path.join(output, 'resources'), { recursive: true });
  for (const entry of ['electron/main.js', 'shared/load-environment.js', ...entries]) {
    const file = path.join(source, entry);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'fixture');
  }
  await createPackage(source, path.join(output, 'resources', 'app.asar'));
  return output;
}

test('desktop package verifies without any local voice engine', async t => {
  const output = await fixture(t);
  assert.ok(await verifyPackage(output) > 0);
});

test('packaging rejects repository and voice-runtime files even when nested inside ASAR', async t => {
  for (const entry of ['node_modules/morphly-api/package.json', 'node_modules/dependency/app/.meanvc/runtime-40ms/python.exe', '.env.production']) {
    const output = await fixture(t, [entry]);
    await assert.rejects(verifyPackage(output), /Unexpected.*app.asar/);
  }
});

test('packaging rejects unpacked voice files and oversized payloads before NSIS', async t => {
  const output = await fixture(t);
  await assert.rejects(verifyPackage(output, { maxBytes: 1 }), /too large/);
  await mkdir(path.join(output, 'resources/morphlyvc/runtime-40ms'), { recursive: true });
  await assert.rejects(verifyPackage(output), /Unexpected file/);
});
