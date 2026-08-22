import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(appDirectory, '..');

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryDirectory, relativePath), 'utf8');
}

test('UnityCapture is pinned as an upstream submodule', () => {
  const gitmodules = readRepositoryFile('.gitmodules');

  assert.match(gitmodules, /path = third_party\/UnityCapture/);
  assert.match(gitmodules, /url = https:\/\/github\.com\/schellingb\/UnityCapture\.git/);
  assert.ok(fs.existsSync(path.join(repositoryDirectory, 'third_party/UnityCapture/Source/shared.inl')));
  assert.ok(fs.existsSync(path.join(repositoryDirectory, 'third_party/UnityCapture/Install/UnityCaptureFilter64.dll')));
});

test('the bridge publishes RGBA frames with UnityCapture shared memory', () => {
  const sender = readRepositoryFile('unity-capture-bridge/src/main.cpp');

  assert.match(sender, /#include "shared\.inl"/);
  assert.match(sender, /SharedImageMemory unityCaptureSender/);
  assert.match(sender, /SharedImageMemory::FORMAT_UINT8/);
  assert.match(sender, /SharedImageMemory::RESIZEMODE_DISABLED/);
  assert.doesNotMatch(sender, /IMFVirtualCamera|MFCreateVirtualCamera|CSourceStream/);
});

test('Electron starts the UnityCapture sender and preserves RGBA channel order', () => {
  const mainProcess = readRepositoryFile('app/electron/main.js');

  assert.match(mainProcess, /morphly_unity_capture_sender\.exe/);
  assert.match(mainProcess, /unity-capture-bridge\/build\/Release/);
  assert.match(mainProcess, /frameBytes = Buffer\.from\(rgbaBytes\)/);
  assert.match(mainProcess, /ensureUnityCaptureRegistration\(\)/);
  assert.doesNotMatch(mainProcess, /morphly_cam_registrar|MorphlyVirtualCameraMF|MFCreateVirtualCamera/);
});

test('packaging includes both upstream filters and registers a branded camera', () => {
  const afterPack = readRepositoryFile('app/build/afterPack.cjs');
  const installer = readRepositoryFile('app/build/installer.nsh');

  assert.match(afterPack, /UnityCaptureFilter32\.dll/);
  assert.match(afterPack, /UnityCaptureFilter64\.dll/);
  assert.match(afterPack, /morphly_unity_capture_sender\.exe/);
  assert.match(installer, /UnityCaptureName=Morphly Virtual Camera/g);
  assert.match(installer, /SysWOW64\\regsvr32\.exe/);
  assert.match(installer, /Sysnative\\regsvr32\.exe/);
  assert.match(installer, /\/s \/u/);
});

test('the retired custom camera source tree and packaged camera DLLs are gone', () => {
  assert.equal(fs.existsSync(path.join(repositoryDirectory, 'native-camera')), false);
  assert.equal(fs.existsSync(path.join(appDirectory, 'src/services/VirtualCameraService.ts')), false);
  assert.equal(
    fs.existsSync(
      path.join(
        appDirectory,
        'release-virtual-camera/win-unpacked/resources/morphly-cam/MorphlyVirtualCameraMF.dll'
      )
    ),
    false
  );
});
