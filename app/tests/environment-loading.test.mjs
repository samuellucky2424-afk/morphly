import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getMorphlyEnvironmentFileCandidates,
  loadMorphlyEnvironment,
} from '../shared/load-environment.js';

test('root environment files load before app fallbacks while runtime values remain authoritative', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'morphly-env-'));
  const workspaceDirectory = path.join(temporaryDirectory, 'workspace');
  const appDirectory = path.join(workspaceDirectory, 'app');
  fs.mkdirSync(appDirectory, { recursive: true });
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(workspaceDirectory, '.env.development.local'),
    'FILE_PRIORITY=workspace-mode-local\nROOT_PRIORITY=workspace-mode-local\nWORKSPACE_VALUE=loaded\n',
  );
  fs.writeFileSync(
    path.join(workspaceDirectory, '.env.local'),
    'FILE_PRIORITY=workspace-local\nLOCAL_VALUE=loaded\n',
  );
  fs.writeFileSync(
    path.join(appDirectory, '.env.development.local'),
    'FILE_PRIORITY=app-mode-local\nROOT_PRIORITY=app-mode-local\nAPP_FALLBACK=loaded\n',
  );

  const processEnvironment = { RUNTIME_VALUE: 'preserved', FILE_PRIORITY: 'runtime' };
  const result = loadMorphlyEnvironment({
    mode: 'development',
    workspaceDirectory,
    appDirectory,
    processEnvironment,
  });

  assert.equal(processEnvironment.RUNTIME_VALUE, 'preserved');
  assert.equal(processEnvironment.FILE_PRIORITY, 'runtime');
  assert.equal(processEnvironment.ROOT_PRIORITY, 'workspace-mode-local');
  assert.equal(processEnvironment.WORKSPACE_VALUE, 'loaded');
  assert.equal(processEnvironment.LOCAL_VALUE, 'loaded');
  assert.equal(processEnvironment.APP_FALLBACK, 'loaded');
  assert.equal(result.loadedFiles[0], path.join(workspaceDirectory, '.env.development.local'));
});

test('test mode does not load the generic local environment file', () => {
  const candidates = getMorphlyEnvironmentFileCandidates({
    mode: 'test',
    workspaceDirectory: 'C:/workspace',
    appDirectory: 'C:/workspace/app',
  });

  assert.equal(candidates.some((candidate) => candidate.endsWith(`${path.sep}.env.local`)), false);
  assert.equal(candidates.some((candidate) => candidate.endsWith(`${path.sep}.env.test.local`)), true);
});

test('the server preload runs before modules that read server credentials', () => {
  const appDirectory = path.resolve(import.meta.dirname, '..');
  const serverEntry = fs.readFileSync(path.join(appDirectory, 'server.js'), 'utf8');
  const electronMain = fs.readFileSync(path.join(appDirectory, 'electron/main.js'), 'utf8');
  const viteConfig = fs.readFileSync(path.join(appDirectory, 'vite.config.ts'), 'utf8');

  assert.match(serverEntry, /^import '\.\/shared\/load-server-environment\.js';/);
  assert.match(electronMain, /loadMorphlyEnvironment\(\)/);
  assert.match(electronMain, /Morphly renderer health:/);
  assert.match(electronMain, /rootChildCount: root\?\.childElementCount \?\? 0/);
  assert.match(viteConfig, /envDir: workspaceDirectory/);
  assert.match(viteConfig, /loadEnv\(mode, workspaceDirectory, ''\)/);
});
