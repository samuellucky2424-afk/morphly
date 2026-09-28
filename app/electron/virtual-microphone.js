import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const runFile = promisify(execFile);
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export async function detectVirtualMicrophone(probePath) {
  if (process.platform !== 'win32') return { installed: false, path: null, error: 'VB-CABLE installation is supported on Windows only.' };
  try {
    const { stdout } = await runFile(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probePath,
    ], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
    const result = JSON.parse(stdout.trim());
    if (typeof result.installed !== 'boolean') throw new Error('Invalid detection response');
    return result;
  } catch (error) {
    return { installed: false, path: null, error: `Unable to check VB-CABLE: ${error.message}` };
  }
}

export function buildVirtualMicrophoneInstallCommand(installerPath) {
  if (!path.win32.isAbsolute(installerPath)) throw new Error('VB-CABLE installer path must be absolute.');
  const literal = (value) => `'${value.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$installer = Start-Process -FilePath ${literal(installerPath)} -WorkingDirectory ${literal(path.win32.dirname(installerPath))} -ArgumentList '-i -h' -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    '@{ exitCode = $installer.ExitCode } | ConvertTo-Json -Compress',
  ].join('\n');
  return {
    file: powershell,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

async function runInstaller(installerPath) {
  const command = buildVirtualMicrophoneInstallCommand(installerPath);
  const { stdout } = await runFile(command.file, command.args, { timeout: 120000, windowsHide: true, encoding: 'utf8' });
  const { exitCode } = JSON.parse(stdout.trim());
  if (!Number.isInteger(exitCode)) throw new Error('The installer did not return an exit code.');
  return exitCode;
}

export function createVirtualMicrophoneService({
  probePath,
  installerPath,
  detect = () => detectVirtualMicrophone(probePath),
  install = () => runInstaller(installerPath),
  installerExists = () => existsSync(installerPath),
  wait = delay,
  verificationAttempts = 6,
}) {
  let pendingInstall = null;
  async function installAndVerify() {
    try {
      let status = await detect();
      if (status.installed) return { success: true, alreadyInstalled: true };
      if (status.error) return { success: false, error: status.error };
      if (status.restartRequired) return { success: false, restartRequired: true, error: 'Restart Windows to finish installing VB-CABLE, then try again.' };
      if (!installerExists()) return { success: false, error: 'VB-CABLE installer not found. Please reinstall Morphly Desktop.' };

      const exitCode = await install();
      // These Windows success codes can require a reboot; none replaces a probe.
      const restartRequired = exitCode === 3010 || exitCode === 1641;
      if (exitCode !== 0 && !restartRequired) {
        return { success: false, exitCode, error: `VB-CABLE installer failed (exit code ${exitCode}).` };
      }
      for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
        if (attempt > 0) await wait(1500);
        status = await detect();
        if (status.installed) return { success: true, exitCode, restartRequired };
      }
      return {
        success: false,
        exitCode,
        restartRequired: restartRequired || Boolean(status.restartRequired),
        error: status.error || 'VB-CABLE setup finished, but Windows has not reported a working driver. Restart Windows and check again. If it is still unavailable, reinstall VB-CABLE.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = /canceled|cancelled|1223/i.test(message);
      const timedOut = error?.killed || /timed?\s*out|ETIMEDOUT/i.test(message);
      return {
        success: false,
        cancelled,
        error: cancelled
          ? 'Installation was cancelled. VB-CABLE requires administrator permission to install.'
          : timedOut
            ? 'VB-CABLE setup did not finish within two minutes. Check for a Windows administrator prompt or an open VB-CABLE installer. Finish or close it before trying again, then fully quit and reopen Morphly.'
          : `VB-CABLE installation failed: ${message}`,
      };
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
