import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { buildVirtualMicrophoneInstallCommand, createVirtualMicrophoneService } from '../electron/virtual-microphone.js';

const missing = { installed: false, registered: false };
const working = { installed: true, registered: true };

test('desktop release packages the driver probe and wires verified installation', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.extraResources.some(item => item.from === 'build/detect-vbcable.ps1' && item.to === 'vbcable/detect-vbcable.ps1'));
  const main = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  assert.match(main, /return virtualMicrophone\.install\(\)/);
  assert.match(main, /return virtualMicrophone\.detect\(\)/);
  assert.doesNotMatch(main, /ExpandProperty InstallDir/);
  const installer = fs.readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
  assert.match(installer, /detect-vbcable\.ps1/);
  assert.match(installer, /vbCableVerify:/);
  assert.doesNotMatch(installer, /ReadRegStr[^\n]*InstallDir/);
});

test('installer timeout gives visible recovery steps', async () => {
  const result = await service({ install: async () => { throw Object.assign(new Error('Command failed'), { killed: true }); } }).install();
  assert.equal(result.success, false);
  assert.match(result.error, /administrator prompt/);
  assert.match(result.error, /before trying again/);
});
function service(options = {}) {
  return createVirtualMicrophoneService({
    detect: async () => missing,
    install: async () => 0,
    installerExists: () => true,
    wait: async () => {},
    verificationAttempts: 3,
    ...options,
  });
}

test('already installed cable skips elevation even without a bundled installer', async () => {
  const result = await service({
    detect: async () => working,
    installerExists: () => false,
    install: () => assert.fail('must not reinstall a working driver'),
  }).install();
  assert.deepEqual(result, { success: true, alreadyInstalled: true });
});

test('successful setup waits for Windows to register the driver and shares concurrent requests', async () => {
  let probes = 0, installs = 0, waits = 0;
  const cable = service({
    detect: async () => ++probes >= 4 ? working : missing,
    install: async () => { installs++; return 0; },
    wait: async () => { waits++; },
  });
  const first = cable.install();
  assert.equal(cable.install(), first);
  assert.equal((await first).success, true);
  assert.equal(probes, 4);
  assert.equal(waits, 2);
  assert.equal(installs, 1);
  assert.equal((await cable.install()).alreadyInstalled, true);
  assert.equal(installs, 1);
});

test('a zero exit code without a working driver never reports success', async () => {
  for (const status of [missing, { installed: false, registered: true }]) {
    const result = await service({ detect: async () => status }).install();
    assert.equal(result.success, false);
    assert.match(result.error, /not reported a working driver/);
  }
});

test('installer errors, cancellation and timeouts return failures and allow retry', async () => {
  for (const message of ['The operation was canceled by the user (1223)', 'Installer timed out']) {
    const cable = service({ install: async () => { throw new Error(message); } });
    const result = await cable.install();
    assert.equal(result.success, false);
    assert.equal(result.cancelled, message.includes('1223'));
    assert.equal((await cable.install()).success, false);
  }
  const result = await service({ install: async () => 5 }).install();
  assert.equal(result.success, false);
  assert.match(result.error, /exit code 5/);
});

test('reboot exit codes still require verified registration', async () => {
  for (const exitCode of [3010, 1641]) {
    const result = await service({ install: async () => exitCode }).install();
    assert.equal(result.success, false);
    assert.equal(result.restartRequired, true);
    let probes = 0;
    const verified = await service({
      detect: async () => ++probes > 1 ? working : missing,
      install: async () => exitCode,
    }).install();
    assert.equal(verified.success, true);
    assert.equal(verified.restartRequired, true);
  }
});

test('probe failures, pending reboot and missing installer prevent elevation', async () => {
  for (const options of [
    { detect: async () => ({ ...missing, error: 'WMI unavailable' }) },
    { detect: async () => ({ ...missing, restartRequired: true }) },
    { installerExists: () => false },
  ]) {
    const result = await service({ ...options, install: () => assert.fail('must not elevate') }).install();
    assert.equal(result.success, false);
    assert.ok(result.error);
  }
});

test('verification errors are preserved instead of claiming the driver is absent', async () => {
  let probes = 0;
  const result = await service({ detect: async () => ++probes === 1 ? missing : { ...missing, error: 'WMI unavailable' } }).install();
  assert.equal(result.success, false);
  assert.equal(result.error, 'WMI unavailable');
});

test('installer runs without a command shell and quotes paths containing shell metacharacters', () => {
  const command = buildVirtualMicrophoneInstallCommand("C:\\Morphly's $app & tools\\VBCABLE_Setup_x64.exe");
  const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Morphly''s \$app & tools/);
  assert.match(script, /-Wait -PassThru -WindowStyle Hidden/);
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
