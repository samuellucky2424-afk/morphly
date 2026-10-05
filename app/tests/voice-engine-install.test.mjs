import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { extractZip, installVoiceEngine, isVoiceEngineInstalled } from '../electron/voice-engine-installer.js';
import { splitVoiceEngine } from '../scripts/split-voice-engine.mjs';
import { VOICE_ENGINE_ASSET_NAME } from '../shared/voice-engine-archive.js';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morphly-install-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const runtimeFiles = ['python.exe', 'src/vc_pipeline_jit.py', 'models/18_asr_jit_warm.pt',
  'models/hq1W_v2_40ms_40ms_gtm_32_run4_newasr_e18_l6_asr2_en_zh_alldata/model_750000_jit.pt'];

for (const restartedVersion of ['2.5.20', '2.5.21']) {
test(`failed extraction survives restart in ${restartedVersion} and finishes entirely offline`, async t => {
  const root = await temporary(t);
  const archive = path.join(root, VOICE_ENGINE_ASSET_NAME);
  await fs.writeFile(archive, 'fixture archive');
  const manifest = await splitVoiceEngine(archive, 100);
  const options = { installRoot: path.join(root, 'engine'), tempRoot: path.join(root, 'downloads'), version: '2.5.20' };
  let originalStage;
  let fetches = 0;
  const dependencies = {
    fetchManifestImpl: async () => { fetches++; return manifest; },
    requestStream: async () => Readable.from([await fs.readFile(archive)]),
    extractZipImpl: async (_archive, stage) => {
      originalStage = stage;
      await fs.writeFile(path.join(stage, 'checkpoint'), 'completed work');
      throw new Error('app closed during extraction');
    },
  };
  await assert.rejects(installVoiceEngine(options, dependencies), /app closed/);
  assert.equal(isVoiceEngineInstalled(options.installRoot), false);
  const progress = [];
  await installVoiceEngine({ ...options, version: restartedVersion, onProgress: event => progress.push(event) }, {
    fetchManifestImpl: () => assert.fail('saved manifest must work offline'),
    requestStream: () => assert.fail('complete archive must not download again'),
    extractZipImpl: async (_archive, stage) => {
      assert.equal(stage, originalStage);
      assert.equal(await fs.readFile(path.join(stage, 'checkpoint'), 'utf8'), 'completed work');
      for (const name of runtimeFiles) {
        const file = path.join(stage, 'runtime-40ms', name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, 'complete');
      }
    },
  });
  assert.equal(fetches, 1);
  assert.equal(isVoiceEngineInstalled(options.installRoot), true);
  assert.ok(!progress.some(event => event.phase === 'downloading'));
  assert.equal(progress.at(-1).phase, 'done');
  await assert.rejects(fs.access(originalStage), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(options.tempRoot, 'download-2.5.20')), { code: 'ENOENT' });
});
}

async function createZip(file, entries) {
  const payload = Buffer.from(JSON.stringify({ file, entries })).toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$data = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))
$zip = [IO.Compression.ZipFile]::Open($data.file, 'Create')
try {
  foreach ($item in $data.entries) {
    $entry = $zip.CreateEntry($item.name)
    $output = $entry.Open()
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($item.data); $output.Write($bytes, 0, $bytes.Length) }
    finally { $output.Dispose() }
  }
} finally { $zip.Dispose() }`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
}

test('Windows extractor resumes finished files, replaces interrupted files and reports progress', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t);
  const stage = path.join(root, "Bob's installation");
  const archive = path.join(root, 'engine.zip');
  await createZip(archive, [
    { name: 'runtime-40ms/', data: '' },
    { name: 'runtime-40ms/done.txt', data: 'finished' },
    { name: 'runtime-40ms/models/new.txt', data: 'full model' },
  ]);
  const completedFile = path.join(stage, 'runtime-40ms/done.txt');
  await fs.mkdir(path.dirname(completedFile), { recursive: true });
  await fs.writeFile(completedFile, 'finished');
  await fs.utimes(completedFile, new Date('2001-01-01'), new Date('2001-01-01'));
  const originalTime = (await fs.stat(completedFile)).mtimeMs;
  await fs.writeFile(path.join(stage, '.entry.tmp'), 'interrupted');
  const progress = [];
  await extractZip(archive, stage, event => progress.push(event));
  assert.equal((await fs.stat(completedFile)).mtimeMs, originalTime, 'must skip completed files');
  assert.equal(await fs.readFile(path.join(stage, 'runtime-40ms/models/new.txt'), 'utf8'), 'full model');
  assert.equal(progress.at(-1).percent, 100);
  assert.ok(progress.every(event => event.phase === 'extracting'));
  await assert.rejects(fs.access(path.join(stage, '.entry.tmp')), { code: 'ENOENT' });
});

test('Windows extractor rejects archive paths outside its runtime staging directory', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t);
  const archive = path.join(root, 'engine.zip');
  await createZip(archive, [{ name: 'runtime-40ms/../../outside.txt', data: 'unsafe' }]);
  await assert.rejects(extractZip(archive, path.join(root, 'staging')), /unsafe path/);
  await assert.rejects(fs.access(path.join(root, 'outside.txt')), { code: 'ENOENT' });
});
test('Windows extractor accepts a root entry and installs files beyond the legacy path limit', {skip:process.platform!=='win32'},async t=>{
  const root=await temporary(t),archive=path.join(root,'long-path.zip'),stage=path.join(root,'staging');
  const relative='runtime-40ms/'+Array.from({length:12},(_,i)=>`torch-header-directory-${i}`).join('/')+'/model.txt';
  assert.ok(path.join(stage,relative).length>260);
  await createZip(archive,[{name:'runtime-40ms',data:''},{name:relative,data:'long-path model'}]);
  await extractZip(archive,stage);
  assert.equal(await fs.readFile(path.join(stage,relative),'utf8'),'long-path model');
});
