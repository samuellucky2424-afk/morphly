import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(appDirectory, '..');

test('packaged runtime probes and repairs the virtual camera without blocking Electron', () => {
  const mainProcess = fs.readFileSync(path.join(appDirectory, 'electron/main.js'), 'utf8');

  assert.match(mainProcess, /const registrationResult = await ensureVirtualCameraRegistration/);
  assert.match(mainProcess, /attemptRepair: app\.isPackaged/);
  assert.match(mainProcess, /const child = spawn\(registrarPath, args/);
  assert.doesNotMatch(mainProcess, /spawnSync/);
  assert.doesNotMatch(mainProcess, /Get-PnpDevice|Get-CimInstance/);
});

test('registrar uses Media Foundation as the authoritative modern-camera probe', () => {
  const registrar = fs.readFileSync(
    path.join(repositoryDirectory, 'native-camera/src/tools/registrar/main.cpp'),
    'utf8',
  );
  const probeCommand = registrar.slice(
    registrar.indexOf('else if (command == L"probe")'),
    registrar.indexOf('else if (command == L"register")'),
  );

  assert.match(probeCommand, /result = ProbeRegisteredWindowsVirtualCamera\(\)/);
  assert.match(probeCommand, /const HRESULT directShowResult = ProbeRegisteredDirectShowCamera\(\)/);
  assert.match(probeCommand, /Media Foundation remains healthy/);
  assert.doesNotMatch(probeCommand, /result = ProbeRegisteredDirectShowCamera\(\)/);
  assert.doesNotMatch(probeCommand, /result = ProbeEnumeratedWindowsVirtualCamera\(\)/);
});

test('authoritative camera health probe requires a real video sample', () => {
  const registrar = fs.readFileSync(
    path.join(repositoryDirectory, 'native-camera/src/tools/registrar/main.cpp'),
    'utf8',
  );
  const probe = registrar.slice(
    registrar.indexOf('HRESULT ProbeWindowsVirtualCameraStream()'),
    registrar.indexOf('HRESULT ProbeEnumeratedWindowsVirtualCamera()'),
  );

  assert.match(probe, /MFCreateSourceReaderFromMediaSource\(/);
  assert.match(probe, /reader->ReadSample\(/);
  assert.match(probe, /callback->WaitForSample\(5000, &streamFlags, &sample\)/);
  assert.match(probe, /buffer->GetCurrentLength\(&byteCount\)/);
  assert.match(probe, /ProbeWindowsVirtualCameraStream\(\)/);
});

test('installer registers DirectShow after replacing the Media Foundation camera', () => {
  const registrar = fs.readFileSync(
    path.join(repositoryDirectory, 'native-camera/src/tools/registrar/main.cpp'),
    'utf8',
  );
  const installCamera = registrar.slice(
    registrar.indexOf('HRESULT InstallCamera()'),
    registrar.indexOf('HRESULT RegisterDirectShowCameraOnly()'),
  );

  const mediaFoundationStart = installCamera.indexOf('camera->Start(nullptr)');
  const directShowRegistration = installCamera.indexOf(
    'InvokeRegisteredBinary(kDirectShowDllName, "DllRegisterServer", true)',
  );

  assert.ok(mediaFoundationStart >= 0);
  assert.ok(directShowRegistration > mediaFoundationStart);
});

test('active-camera repair stages a new DLL instead of re-registering the locked build', () => {
  const registrar = fs.readFileSync(
    path.join(repositoryDirectory, 'native-camera/src/tools/registrar/main.cpp'),
    'utf8',
  );
  const staging = registrar.slice(
    registrar.indexOf('HRESULT GetSideBySideBinaryPath('),
    registrar.indexOf('std::filesystem::path ResolveBinaryForUnregister('),
  );

  assert.match(staging, /GetSideBySideBinaryPath\(/);
  assert.match(staging, /std::filesystem::copy_file\(\s*sourcePath,\s*sideBySidePath/);
  assert.match(staging, /\*stagedPath = sideBySidePath/);
  assert.doesNotMatch(staging, /reusing existing copy/);
});

test('Media Foundation source uses container-safe samples and one QPC timeline', () => {
  const mediaSource = fs.readFileSync(
    path.join(
      repositoryDirectory,
      'native-camera/src/virtualcam/mf_virtual_camera_source.cpp',
    ),
    'utf8',
  );

  assert.match(
    mediaSource,
    /\*usage = MFSampleAllocatorUsage_UsesProvidedAllocator/,
  );
  assert.doesNotMatch(
    mediaSource,
    /\*usage = MFSampleAllocatorUsage_UsesCustomAllocator/,
  );
  assert.match(mediaSource, /stream_->SetSampleAllocator\(videoAllocator\.Get\(\)\)/);
  assert.match(mediaSource, /sampleAllocator->AllocateSample\(&value\)/);
  assert.match(mediaSource, /buffer2D->ContiguousCopyFrom\(/);
  assert.match(
    mediaSource,
    /InitPropVariantFromInt64\(\s*static_cast<LONGLONG>\(MFGetSystemTime\(\)\)/,
  );
  assert.doesNotMatch(
    mediaSource,
    /SetUINT64\(MF_EVENT_SOURCE_ACTUAL_START,\s*0\)/,
  );
});
