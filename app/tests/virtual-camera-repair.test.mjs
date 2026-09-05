import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCameraRepairCommand, createCameraRepairService, supportsMediaFoundationCamera } from '../electron/virtual-camera-repair.js';

test('camera repair is single-flight and success requires a fresh verification', async () => {
  let probes = 0, repairs = 0;
  const service = createCameraRepairService({ probe: async () => ({ success: ++probes > 1, canRepair: true }), repair: async () => { repairs++; return { success: true }; } });
  const first = service.repair();
  assert.equal(first, service.repair());
  assert.equal((await first).repaired, true);
  assert.equal(probes, 2); assert.equal(repairs, 1);
  assert.equal((await service.repair()).repaired, false);
  assert.equal(repairs, 1);
});

test('cancelled, unsupported and unverified repairs never claim success', async () => {
  for (const result of [{ success: false, cancelled: true }, { success: false, timedOut: true }, { success: true }]) {
    const service = createCameraRepairService({ probe: async () => ({ success: false, canRepair: true }), repair: async () => result });
    assert.equal((await service.repair()).success, false);
  }
  const service = createCameraRepairService({ probe: async () => ({ success: false, canRepair: false }), repair: () => assert.fail('unsupported OS must not launch elevation') });
  assert.equal((await service.repair()).success, false);
});

test('camera elevation uses only fixed absolute paths, quotes safely and hides helper windows', () => {
  const config = { windowsDirectory: 'C:\\Windows', filters: [{ bits: 32, path: "C:\\Program Files\\Morphly's App\\UnityCaptureFilter32.dll" }, { bits: 64, path: 'C:\\Program Files\\Morphly\\UnityCaptureFilter64.dll' }], registrar: 'C:\\Program Files\\Morphly\\morphly_cam_registrar.exe', mediaFoundationSupported: true };
  const command = buildCameraRepairCommand(config);
  const outer = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(outer, /-Verb RunAs -PassThru -Wait -WindowStyle Hidden/);
  const inner = Buffer.from(outer.match(/Bypass -EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le');
  assert.match(inner, /Morphly''s App/);
  assert.match(inner, /SysWOW64\\regsvr32/); assert.match(inner, /System32\\regsvr32/);
  assert.match(inner, /install --all-users/); assert.doesNotMatch(inner, /Remove-Item|uninstall|\s\/u\s/);
  assert.throws(() => buildCameraRepairCommand({ ...config, registrar: 'relative.exe' }), /absolute/);
  assert.throws(() => buildCameraRepairCommand({ ...config, filters: [] }), /Both/);
});

test('camera capability differentiates Windows 10 from Windows 11', () => {
  assert.equal(supportsMediaFoundationCamera('win32', '10.0.19045'), false);
  assert.equal(supportsMediaFoundationCamera('win32', '10.0.22000'), true);
  assert.equal(supportsMediaFoundationCamera('darwin', '25.0.0'), false);
});

test('upgrade preserves registration and runtime probes do not capture frames', async () => {
  const installer = await readFile(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  assert.match(installer, /\$\{isUpdated\}[\s\S]*Goto customUnInstallDone/);
  assert.match(installer, /IntCmp \$R2 22000/);
  assert.match(installer, /morphly_cam_registrar\.exe" probe-registration/);
  const registrar = await readFile(new URL('../../native-camera/src/tools/registrar/main.cpp', import.meta.url), 'utf8');
  assert.match(registrar, /ProbeRegisteredWindowsVirtualCamera\(false\)/);
  assert.match(registrar, /SameBinary\(sourcePath, sideBySidePath\)/);
  assert.match(registrar, /ERROR_SHARING_VIOLATION[\s\S]*ERROR_ACCESS_DENIED/);
  const main = await readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
  assert.match(main, /runMediaFoundationCameraRegistrar\(\['probe-registration'\]\)/);
  assert.match(main, /event\.senderFrame === event\.sender\.mainFrame/);
  assert.match(main, /if \(virtualCameraLiveSession\) return \{ success: false, error: 'Stop live streaming/);
  assert.doesNotMatch(main, /if \(morphlyCamPublisher[^\n]*Stop live streaming/);
});
