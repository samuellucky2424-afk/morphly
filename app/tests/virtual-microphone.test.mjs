import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VBCABLE_PACK_URL, VBCABLE_REQUIRED_FILES, buildVirtualMicrophoneInstallCommand, buildVirtualMicrophonePrepareCommand, createVirtualMicrophoneService, downloadVirtualMicrophonePack } from '../electron/virtual-microphone.js';

const missing = { installed: false, registered: false };
const working = { installed: true, registered: true };

test('VB-CABLE is not embedded in the Morphly installer; the app downloads the official pack', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.extraResources.some(item => item.from === 'build/detect-vbcable.ps1' && item.to === 'vbcable/detect-vbcable.ps1'));
  assert.equal(pkg.build.extraResources.some(item => /VBCABLE_Setup/i.test(item.from)), false);
  assert.equal(fs.existsSync(new URL('../build/VBCABLE_Setup_x64.exe', import.meta.url)), false);
  const main = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  assert.match(main, /return virtualMicrophone\.install\(\)/);
  assert.match(main, /return virtualMicrophone\.detect\(\)/);
  const installer = fs.readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  assert.doesNotMatch(installer, /VBCABLE|vbcable|vbCable/);
  assert.equal(VBCABLE_PACK_URL, 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip');
  assert.ok(VBCABLE_REQUIRED_FILES.includes('vbMmeCable64_win10.inf'));
});

function service(options = {}) {
  return createVirtualMicrophoneService({
    detect: async () => missing,
    download: async () => 'C:\\Temp\\pack.zip',
    prepare: async () => 'C:\\Temp\\pack\\VBCABLE_Setup_x64.exe',
    install: async () => 0,
    cleanup: async () => {},
    wait: async () => {},
    verificationAttempts: 3,
    ...options,
  });
}

test('already installed cable skips download and elevation', async () => {
  const result = await service({
    detect: async () => working,
    download: () => assert.fail('must not download'),
    install: () => assert.fail('must not reinstall a working driver'),
  }).install();
  assert.deepEqual(result, { success: true, alreadyInstalled: true });
});

test('setup runs from the extracted, verified pack and waits for Windows to register the driver', async () => {
  let probes = 0, installs = 0, waits = 0, cleaned = 0, installedFrom;
  const cable = service({
    detect: async () => ++probes >= 4 ? working : missing,
    prepare: async zip => { assert.equal(zip, 'C:\\Temp\\pack.zip'); return 'C:\\Temp\\pack\\VBCABLE_Setup_x64.exe'; },
    install: async setup => { installs++; installedFrom = setup; return 0; },
    wait: async () => { waits++; },
    cleanup: async () => { cleaned++; },
  });
  const first = cable.install();
  assert.equal(cable.install(), first, 'concurrent requests share one install');
  assert.equal((await first).success, true);
  assert.equal(installedFrom, 'C:\\Temp\\pack\\VBCABLE_Setup_x64.exe');
  assert.equal(probes, 4);
  assert.equal(waits, 2);
  assert.equal(installs, 1);
  assert.equal(cleaned, 1);
});

test('a registered but inactive fresh driver asks for a restart instead of failing', async () => {
  for (const exitCode of [0, 3010, 1641]) {
    const result = await service({ detect: async () => ({ installed: false, registered: true }), install: async () => exitCode }).install();
    assert.equal(result.success, true);
    assert.equal(result.restartRequired, true);
  }
  let probes = 0;
  const pending = await service({ detect: async () => ++probes === 1 ? missing : { ...missing, restartRequired: true, registered: true } }).install();
  assert.equal(pending.restartRequired, true);
});

test('setup that never registers a driver reports failure', async () => {
  const result = await service().install();
  assert.equal(result.success, false);
  assert.match(result.error, /has not reported the driver/);
});

test('download, verification, cancellation, timeout and exit-code failures are explained and retryable', async () => {
  const cases = [
    [{ download: async () => { throw Object.assign(new Error('fetch failed'), { stage: 'download' }); } }, /could not download VB-CABLE/],
    [{ prepare: async () => { throw Object.assign(new Error('VBCABLE_UNSIGNED'), { stage: 'verify' }); } }, /security check/],
    [{ prepare: async () => { throw Object.assign(new Error('VBCABLE_MISSING x.inf'), { stage: 'verify' }); } }, /incomplete/],
    [{ install: async () => { throw new Error('The operation was canceled by the user (1223)'); } }, /administrator permission/],
    [{ install: async () => { throw Object.assign(new Error('Command failed'), { killed: true }); } }, /did not finish/],
    [{ install: async () => 5 }, /exit code 5/],
  ];
  for (const [options, expected] of cases) {
    const cable = service(options);
    const result = await cable.install();
    assert.equal(result.success, false);
    assert.match(result.error, expected);
    assert.equal((await cable.install()).success, false, 'a failed attempt can be retried');
  }
});

test('a pending reboot is reported before downloading again', async () => {
  const result = await service({ detect: async () => ({ ...missing, restartRequired: true }), download: () => assert.fail('must not download') }).install();
  assert.equal(result.restartRequired, true);
  assert.match(result.error, /Restart Windows/);
});

test('pack preparation extracts every file and requires VB-Audio\'s signature before elevation', () => {
  const command = buildVirtualMicrophonePrepareCommand("C:\\Users\\O'Neil\\pack.zip", 'C:\\Temp\\pack');
  const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Expand-Archive -LiteralPath 'C:\\Users\\O''Neil\\pack.zip'/);
  assert.match(script, /vbaudio_cable64_win10\.sys/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /BUREL VINCENT/);
  assert.throws(() => buildVirtualMicrophonePrepareCommand('pack.zip', 'C:\\Temp'), /absolute/);
});

test('downloads reject responses that are not a driver pack', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbcable-test-'));
  try {
    await assert.rejects(downloadVirtualMicrophonePack(tmp, { fetchImpl: async () => new Response('<html>', { status: 200 }) }), error => error.stage === 'verify');
    await assert.rejects(downloadVirtualMicrophonePack(tmp, { fetchImpl: async () => new Response('', { status: 404 }) }), error => error.stage === 'download');
    const zip = Buffer.alloc(300 * 1024); zip[0] = 0x50; zip[1] = 0x4b;
    const saved = await downloadVirtualMicrophonePack(tmp, { fetchImpl: async () => new Response(zip) });
    assert.equal(fs.statSync(saved).size, zip.length);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('installer runs without a command shell and quotes paths containing shell metacharacters', () => {
  const command = buildVirtualMicrophoneInstallCommand("C:\\Morphly's $app & tools\\VBCABLE_Setup_x64.exe");
  const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Morphly''s \$app & tools/);
  assert.match(script, /-ArgumentList '-i' -Verb RunAs -Wait -PassThru/);
  assert.doesNotMatch(script, /WindowStyle Hidden|-i -h/, 'the VB-CABLE installer is shown to the user');
  assert.match(script, /exitCode = \$installer.ExitCode/);
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
  assert.throws(() => buildVirtualMicrophoneInstallCommand('relative.exe'), /absolute/);
});

test('PowerShell probe handles absent, healthy, broken, duplicate and rebooting devices without InstallDir', { skip: process.platform !== 'win32' }, async () => {
  const probe = fileURLToPath(new URL('../build/detect-vbcable.ps1', import.meta.url)).replace(/'/g, "''");
  const fixtures = [
    { codes: [], installed: false, registered: false, restartRequired: false },
    { codes: [0], installed: true, registered: true, restartRequired: false },
    { codes: [10, 0, 10], installed: true, registered: true, restartRequired: false },
    { codes: [10, 22], installed: false, registered: true, restartRequired: false },
    { codes: [14], installed: false, registered: true, restartRequired: true },
  ];
  for (const fixture of fixtures) {
    const devices = fixture.codes.map(code => `[pscustomobject]@{ ConfigManagerErrorCode = ${code} }`).join('; ');
    const script = `function Get-CimInstance { param($ClassName, $Filter, $OperationTimeoutSec) if ($Filter -ne "Name = 'VB-Audio Virtual Cable'") { throw 'Wrong driver query' }; ${devices} }; & '${probe}'`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    const { codes, ...expected } = fixture;
    assert.deepEqual(JSON.parse(stdout.trim()), { ...expected, path: null });
  }
  const script = `function Get-CimInstance { throw 'WMI unavailable' }; & '${probe}'`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  assert.match(JSON.parse(stdout.trim()).error, /WMI unavailable/);
});