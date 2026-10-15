import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const runFile = promisify(execFile);
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// VB-CABLE's license allows redistributing the official package only as-is and
// forbids embedding it in another installer. Morphly therefore downloads the
// unmodified driver pack from VB-Audio when the user asks to install it.
export const VBCABLE_PACK_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip';
// The setup program loads these driver files from its own folder; without them
// it fails with "LOADDRV: The path does not exist".
export const VBCABLE_REQUIRED_FILES = ['VBCABLE_Setup_x64.exe', 'vbMmeCable64_win10.inf', 'vbaudio_cable64_win10.sys', 'vbaudio_cable64_win10.cat'];
const VBCABLE_SIGNER = 'BUREL VINCENT';
const MIN_PACK_BYTES = 200 * 1024;
const MAX_PACK_BYTES = 20 * 1024 * 1024;

const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const encoded = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

export async function detectVirtualMicrophone(probePath) {
  if (process.platform !== 'win32') return { installed: false, path: null, error: 'VB-CABLE installation is supported on Windows only.' };
  try {
    const { stdout } = await runFile(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probePath,
    ], { timeout: 20000, windowsHide: true, encoding: 'utf8' });
    const result = JSON.parse(stdout.trim());
    if (typeof result.installed !== 'boolean') throw new Error('Invalid detection response');
    return result;
  } catch (error) {
    return { installed: false, path: null, error: `Unable to check VB-CABLE: ${error.message}` };
  }
}

export async function downloadVirtualMicrophonePack(workRoot, { fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  await mkdir(workRoot, { recursive: true });
  const response = await fetchImpl(VBCABLE_PACK_URL, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { stage: 'download' });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < MIN_PACK_BYTES || bytes.length > MAX_PACK_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw Object.assign(new Error('The download is not a VB-CABLE driver package.'), { stage: 'verify' });
  }
  const zipPath = path.join(workRoot, path.basename(new URL(VBCABLE_PACK_URL).pathname));
  await writeFile(zipPath, bytes);
  return zipPath;
}

// Extracts the full pack (setup + driver files) and verifies VB-Audio's
// Authenticode signature before anything is run with administrator rights.
export function buildVirtualMicrophonePrepareCommand(zipPath, extractDir) {
  if (!path.win32.isAbsolute(zipPath) || !path.win32.isAbsolute(extractDir)) throw new Error('VB-CABLE paths must be absolute.');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$dir = ${literal(extractDir)}`,
    "if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }",
    `Expand-Archive -LiteralPath ${literal(zipPath)} -DestinationPath $dir -Force`,
    `$missing = @(${VBCABLE_REQUIRED_FILES.map(literal).join(', ')} | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dir $_)) })`,
    "if ($missing.Count) { throw ('VBCABLE_MISSING ' + ($missing -join ',')) }",
    "$setup = Join-Path $dir 'VBCABLE_Setup_x64.exe'",
    '$signature = Get-AuthenticodeSignature -LiteralPath $setup',
    `if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch ${literal(VBCABLE_SIGNER)}) { throw 'VBCABLE_UNSIGNED' }`,
    '@{ setupPath = $setup } | ConvertTo-Json -Compress',
  ].join('\n');
  return { file: powershell, args: encoded(script) };
}

async function prepareVirtualMicrophonePack(zipPath, extractDir) {
  const command = buildVirtualMicrophonePrepareCommand(zipPath, extractDir);
  try {
    const { stdout } = await runFile(command.file, command.args, { timeout: 60000, windowsHide: true, encoding: 'utf8' });
    const { setupPath } = JSON.parse(stdout.trim());
    if (typeof setupPath !== 'string') throw new Error('The VB-CABLE package could not be prepared.');
    return setupPath;
  } catch (error) {
    throw Object.assign(error, { stage: 'verify' });
  }
}

export function buildVirtualMicrophoneInstallCommand(installerPath) {
  if (!path.win32.isAbsolute(installerPath)) throw new Error('VB-CABLE installer path must be absolute.');
  // The working directory must be the extracted pack: setup loads the driver
  // .inf/.sys/.cat files from there. The installer runs visibly: Windows asks
  // for administrator approval, then VB-CABLE's own window installs the driver
  // and shows its result.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$installer = Start-Process -FilePath ${literal(installerPath)} -WorkingDirectory ${literal(path.win32.dirname(installerPath))} -ArgumentList '-i' -Verb RunAs -Wait -PassThru`,
    '@{ exitCode = $installer.ExitCode } | ConvertTo-Json -Compress',
  ].join('\n');
  return {
    file: powershell,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

async function runInstaller(installerPath) {
  const command = buildVirtualMicrophoneInstallCommand(installerPath);
  // Allow time for the user to read and close VB-CABLE's completion dialog.
  const { stdout } = await runFile(command.file, command.args, { timeout: 600000, windowsHide: true, encoding: 'utf8' });
  const { exitCode } = JSON.parse(stdout.trim());
  if (!Number.isInteger(exitCode)) throw new Error('The installer did not return an exit code.');
  return exitCode;
}

function failureMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/canceled|cancelled|1223/i.test(message)) {
    return { cancelled: true, error: 'Installation was cancelled. VB-CABLE needs administrator permission; choose Yes when Windows asks.' };
  }
  if (error?.stage === 'download') {
    return { error: 'Morphly could not download VB-CABLE from vb-audio.com. Check your internet connection, then try again.' };
  }
  if (error?.stage === 'verify') {
    return { error: /VBCABLE_UNSIGNED/.test(message)
      ? 'The downloaded VB-CABLE package failed its security check and was not installed. Try again later or install it from vb-audio.com.'
      : 'The downloaded VB-CABLE package was incomplete and was not installed. Try again.' };
  }
  if (error?.killed || /timed?\s*out|ETIMEDOUT|TimeoutError|aborted/i.test(message) || error?.name === 'TimeoutError') {
    return { error: 'VB-CABLE setup did not finish. Check for a Windows administrator prompt or an open VB-CABLE window behind Morphly, finish or close it, then try again.' };
  }
  return { error: `VB-CABLE installation failed: ${message}` };
}

export function createVirtualMicrophoneService({
  probePath,
  workRoot,
  detect = () => detectVirtualMicrophone(probePath),
  download = () => downloadVirtualMicrophonePack(workRoot),
  prepare = (zipPath) => prepareVirtualMicrophonePack(zipPath, path.join(workRoot, 'pack')),
  install = runInstaller,
  cleanup = () => (workRoot ? rm(workRoot, { recursive: true, force: true }) : Promise.resolve()),
  wait = delay,
  verificationAttempts = 10,
  verificationDelayMs = 2000,
}) {
  let pendingInstall = null;
  async function installAndVerify() {
    try {
      let status = await detect();
      if (status.installed) return { success: true, alreadyInstalled: true };
      if (status.restartRequired) return { success: false, restartRequired: true, error: 'VB-CABLE is installed but Windows needs a restart to finish. Restart Windows, then reopen Morphly.' };

      const setupPath = await prepare(await download());
      const exitCode = await install(setupPath);
      const restartRequired = exitCode === 3010 || exitCode === 1641;
      if (exitCode !== 0 && !restartRequired) {
        return { success: false, exitCode, error: `VB-CABLE setup failed (exit code ${exitCode}). Restart Windows and try again, or install it from vb-audio.com.` };
      }
      for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
        if (attempt > 0) await wait(verificationDelayMs);
        status = await detect();
        if (status.installed) return { success: true, exitCode, restartRequired };
      }
      // A freshly installed driver commonly stays inactive until Windows restarts.
      if (status.registered || restartRequired) {
        return { success: true, exitCode, restartRequired: true };
      }
      return {
        success: false,
        exitCode,
        error: status.error || 'VB-CABLE setup finished, but Windows has not reported the driver. Restart Windows and check again.',
      };
    } catch (error) {
      return { success: false, ...failureMessage(error) };
    } finally {
      await cleanup().catch(() => {});
    }
  }
  return {
    detect,
    install() {
      if (!pendingInstall) pendingInstall = installAndVerify().finally(() => { pendingInstall = null; });
      return pendingInstall;
    },
  };
}
