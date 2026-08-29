import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(appDirectory, '..');
const require = createRequire(import.meta.url);
const {
  buildElevationCommand,
  ensureRegistration,
} = require('../scripts/ensure-unity-capture-registration.cjs');

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
  assert.match(sender, /SharedImageMemory::RESIZEMODE_LINEAR/);
  assert.match(sender, /SENDRES_WARN_FRAMESKIP/);
  assert.match(sender, /kSkippedFramesBeforeReceiverIsInactive/);
  assert.doesNotMatch(sender, /IMFVirtualCamera|MFCreateVirtualCamera|CSourceStream/);
});

test('Electron starts the UnityCapture sender with an adaptive latest-frame publisher', () => {
  const mainProcess = readRepositoryFile('app/electron/main.js');

  assert.match(mainProcess, /morphly_unity_capture_sender\.exe/);
  assert.match(mainProcess, /unity-capture-bridge\/build\/Release/);
  assert.match(mainProcess, /selectVirtualCameraProfile\(\)/);
  assert.match(mainProcess, /MORPHLY_DISABLE_HARDWARE_ACCELERATION/);
  assert.match(mainProcess, /frameBytes = Buffer\.from\(pixels\.buffer, pixels\.byteOffset, pixels\.byteLength\)/);
  assert.match(mainProcess, /controller\.latestRendererFrame = rendererFrame/);
  assert.doesNotMatch(mainProcess, /frameQueue/);
  assert.match(mainProcess, /controller\.stderrBuffer \+= chunk\.toString\(\)/);
  assert.match(mainProcess, /virtual-camera:receiver-state/);
  assert.match(mainProcess, /controller\.stopping[\s\S]*morphlyCamPublisher !== controller[\s\S]*controller\.receiverReady === connected/);
  assert.match(mainProcess, /controller\.receiverReady === false[\s\S]*?VIRTUAL_CAM_RECEIVER_PROBE_INTERVAL_MS/);
  assert.match(mainProcess, /VIDEO_INPUT_DEVICE_CATEGORY/);
  assert.match(mainProcess, /normalizeWindowsPath\(registeredFilterPath\) === normalizeWindowsPath\(expectedFilterPath\)/);
  assert.match(mainProcess, /child\.on\('exit',[\s\S]*?clearTimeout\(controller\.timer\)/);
  assert.match(mainProcess, /if \(morphlyCamPublisher === controller\) \{[\s\S]*sendVirtualCameraReceiverState\(false\)/);
  assert.match(mainProcess, /operationGeneration !== virtualCameraOperationGeneration/);
  assert.match(mainProcess, /ensureUnityCaptureRegistration\(\)/);
  assert.doesNotMatch(mainProcess, /morphly_cam_registrar|MorphlyVirtualCameraMF|MFCreateVirtualCamera/);
});

test('the renderer publishes one decoded-frame path without an extra typed-array copy', () => {
  const dashboard = readRepositoryFile('app/src/pages/Dashboard.tsx');
  const publisherCalls = dashboard.match(/pushMorphlyCamFrame\(currentCanvas, renderContext\)/g) ?? [];

  assert.match(dashboard, /requestVideoFrameCallback\(renderFrame\)/);
  assert.match(dashboard, /pixels: imageData\.data/);
  assert.match(dashboard, /virtualCameraReceiverConnectedRef\.current !== false/);
  assert.doesNotMatch(dashboard, /new Uint8ClampedArray\(imageData\.data\)/);
  assert.equal(publisherCalls.length, 1);
});

test('packaging includes both upstream filters and registers a branded camera', () => {
  const afterPack = readRepositoryFile('app/build/afterPack.cjs');
  const installer = readRepositoryFile('app/build/installer.nsh');
  const registrationScript = readRepositoryFile('app/scripts/unity-capture-registration.cjs');
  const packageConfig = JSON.parse(readRepositoryFile('app/package.json'));
  const releaseWorkflow = readRepositoryFile('.github/workflows/release.yml');

  assert.match(afterPack, /UnityCaptureFilter32\.dll/);
  assert.match(afterPack, /UnityCaptureFilter64\.dll/);
  assert.match(afterPack, /morphly_unity_capture_sender\.exe/);
  assert.match(registrationScript, /VIDEO_INPUT_DEVICE_CATEGORY/);
  assert.match(registrationScript, /normalizeWindowsPath\(registeredFilterPath\) === normalizeWindowsPath\(expectedFilterPath\)/);
  assert.match(installer, /UnityCaptureName=Morphly Virtual Camera/g);
  assert.match(installer, /SysWOW64\\regsvr32\.exe/);
  assert.match(installer, /Sysnative\\regsvr32\.exe/);
  assert.match(installer, /\/s \/u/);
  assert.match(installer, /ReadRegStr \$2 HKLM [^\n]+5C2CD55C-92AD-4999-8666-912BD3E70020/);
  assert.match(installer, /ReadRegStr \$3 HKLM [^\n]+5C2CD55C-92AD-4999-8666-912BD3E70010/);
  assert.match(installer, /StrCmp \$2 "\$INSTDIR\\resources\\unity-capture\\UnityCaptureFilter32\.dll"/);
  assert.match(installer, /StrCmp \$3 "\$INSTDIR\\resources\\unity-capture\\UnityCaptureFilter64\.dll"/);
  assert.match(installer, /FriendlyName/);
  assert.match(installer, /MB_ICONSTOP\|MB_RETRYCANCEL/);
  assert.match(installer, /SetErrorLevel 1603[\s\S]*Quit/);
  assert.deepEqual(packageConfig.build.win.target, ['nsis']);
  assert.ok(packageConfig.build.files.includes('shared/**/*'));
  assert.equal(packageConfig.build.nsis.perMachine, true);
  assert.equal(packageConfig.build.nsis.allowElevation, true);
  assert.match(releaseWorkflow, /Morphly-Setup-\$version\.exe/);
  assert.doesNotMatch(releaseWorkflow, /Missing portable build/);
  assert.match(releaseWorkflow, /run: npm run electron:build/);
  assert.match(releaseWorkflow, /Publish verified release/);
  assert.doesNotMatch(releaseWorkflow, /run: npm run electron:release/);
  assert.ok(releaseWorkflow.indexOf('run: npm run electron:build') < releaseWorkflow.indexOf('Verify release artifacts'));
  assert.ok(releaseWorkflow.indexOf('Verify release artifacts') < releaseWorkflow.indexOf('Publish verified release'));
});

test('development registration requests elevation once and verifies both camera registrations', () => {
  const calls = [];
  const results = [
    { status: 1, stdout: '', stderr: 'missing' },
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: 'registered', stderr: '' },
  ];
  const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';
  const registrationScript = "D:\\Morphly's App\\unity-capture-registration.cjs";

  const result = ensureRegistration({
    platform: 'win32',
    nodeExecutable,
    registrationScript,
    runCommand(executable, args, options) {
      calls.push({ executable, args, options });
      return results.shift();
    },
  });

  assert.deepEqual(result, { elevated: true, skipped: false });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    executable: nodeExecutable,
    args: [registrationScript, 'probe'],
    options: undefined,
  });
  assert.equal(calls[1].executable, 'powershell.exe');
  assert.equal(calls[1].options.stdio, 'inherit');
  const encodedCommandIndex = calls[1].args.indexOf('-EncodedCommand');
  assert.notEqual(encodedCommandIndex, -1);
  const elevationCommand = Buffer.from(calls[1].args[encodedCommandIndex + 1], 'base64').toString('utf16le');
  assert.equal(elevationCommand, buildElevationCommand(nodeExecutable, registrationScript));
  assert.match(elevationCommand, /Start-Process -FilePath/);
  assert.match(elevationCommand, /-Verb RunAs -Wait -PassThru -WindowStyle Hidden/);
  assert.match(elevationCommand, /Morphly''s App/);
  assert.deepEqual(calls[2].args, [registrationScript, 'probe']);
});

test('development registration refuses to launch after a cancelled UAC prompt', () => {
  const results = [
    { status: 1, stdout: '', stderr: 'missing' },
    { status: 1, stdout: '', stderr: '' },
  ];

  assert.throws(
    () => ensureRegistration({
      platform: 'win32',
      runCommand() {
        return results.shift();
      },
    }),
    /registration was cancelled or failed[\s\S]*Electron will not start/,
  );
});

test('desktop development builds the native sender before launching Electron', () => {
  const packageConfig = JSON.parse(readRepositoryFile('app/package.json'));
  const mainProcess = readRepositoryFile('app/electron/main.js');
  const devLauncher = readRepositoryFile('app/scripts/launch-branded-electron-dev.cjs');
  const liveDevLauncher = readRepositoryFile('app/scripts/launch-live-electron-dev.cjs');
  const viteConfig = readRepositoryFile('app/vite.config.ts');

  assert.equal(
    packageConfig.scripts['preelectron:dev'],
    'npm run virtual-camera:build && npm run virtual-camera:ensure',
  );
  assert.equal(
    packageConfig.scripts['preelectron:only'],
    'npm run virtual-camera:build && npm run virtual-camera:ensure',
  );
  assert.equal(
    packageConfig.scripts['preelectron:dev:live'],
    'npm run virtual-camera:build && npm run virtual-camera:ensure',
  );
  assert.equal(
    packageConfig.scripts['virtual-camera:ensure'],
    'node scripts/ensure-unity-capture-registration.cjs',
  );
  assert.match(packageConfig.scripts['electron:dev:wait:live'], /tcp:127\.0\.0\.1:5173/);
  assert.doesNotMatch(packageConfig.scripts['electron:dev:wait:live'], /3000/);
  assert.match(devLauncher, /childEnvironment\.MORPHLY_DESKTOP_DEV = '1'/);
  assert.match(mainProcess, /process\.env\.MORPHLY_DESKTOP_DEV === '1'/);
  assert.match(mainProcess, /const isPackagedRuntime = app\.isPackaged && !isDevelopment/);
  assert.match(mainProcess, /if \(isPackagedRuntime\) \{[\s\S]*unity-capture-bridge\/build\/Release/);
  assert.match(liveDevLauncher, /https:\/\/morphly-alpha\.vercel\.app/);
  assert.match(liveDevLauncher, /Public client configuration: verified \(values hidden\)/);
  assert.match(liveDevLauncher, /spawn\(process\.execPath, \[npmCliPath/);
  assert.doesNotMatch(liveDevLauncher, /console\.(?:info|log)\([^\n]*(?:supabaseUrl|supabaseAnonKey)/);
  assert.match(viteConfig, /const runtimeEnv = \{ \.\.\.env, \.\.\.process\.env \}/);
  assert.match(viteConfig, /runtimeEnv\.VITE_API_PROXY_TARGET/);
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
