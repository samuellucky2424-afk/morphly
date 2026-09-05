import { execFile } from 'node:child_process';
import path from 'node:path';

export function supportsMediaFoundationCamera(platform, release) {
  return platform === 'win32' && Number(String(release).split('.')[2]) >= 22000;
}

function literal(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid camera component path.');
  return `'${value.replace(/'/g, "''")}'`;
}

// All paths come from the main process, never from an IPC payload or a download.
export function buildCameraRepairCommand({ windowsDirectory, filters, registrar, mediaFoundationSupported }) {
  for (const value of [windowsDirectory, ...filters.map(f => f.path), ...(mediaFoundationSupported ? [registrar] : [])]) {
    if (!value || !path.win32.isAbsolute(value)) throw new Error('Camera repair requires absolute component paths.');
  }
  if (filters.length !== 2 || !filters.some(f => f.bits === 32) || !filters.some(f => f.bits === 64)) {
    throw new Error('Both camera filter architectures are required.');
  }
  const commands = ["$ErrorActionPreference = 'Stop'", 'try {'];
  for (const filter of filters) {
    const exe = path.win32.join(windowsDirectory, filter.bits === 32 ? 'SysWOW64' : 'System32', 'regsvr32.exe');
    commands.push(`& ${literal(exe)} /s '/i:UnityCaptureName=Morphly Virtual Camera' ${literal(filter.path)}`);
    commands.push('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  }
  if (mediaFoundationSupported) {
    commands.push(`& ${literal(registrar)} install --all-users`);
    commands.push('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  }
  commands.push('exit 0', '} catch { exit 1 }');
  const encoded = Buffer.from(commands.join('\r\n'), 'utf16le').toString('base64');
  const powershell = path.win32.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const elevation = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `$cameraRepair = Start-Process -FilePath ${literal(powershell)} -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -Verb RunAs -PassThru -Wait -WindowStyle Hidden`,
    'exit $cameraRepair.ExitCode',
    '} catch { exit 1223 }',
  ].join('\r\n');
  return { executable: powershell, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(elevation, 'utf16le').toString('base64')] };
}

export function executeCameraRepair(command) {
  return new Promise((resolve) => {
    execFile(command.executable, command.args, { windowsHide: true, timeout: 180000, maxBuffer: 65536 }, (error) => {
      resolve({ success: !error, cancelled: error?.code === 1223, timedOut: Boolean(error?.killed) });
    });
  });
}

export function createCameraRepairService({ probe, repair }) {
  let inFlight = null;
  return {
    status: () => probe(),
    repair() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const before = await probe();
        if (before.success) return { ...before, repaired: false };
        if (before.canRepair === false) return before;
        const result = await repair();
        if (!result.success) return { success: false, canRepair: true, error: result.cancelled
          ? 'Camera repair was cancelled. No Administrator approval was granted.'
          : result.timedOut
            ? 'Camera repair has not finished. Wait for the Windows installer to close, then check again.'
            : 'Windows could not repair the camera. Close apps using Morphly Virtual Camera and try again.' };
        const after = await probe();
        return after.success ? { ...after, repaired: true, message: 'Camera registration repaired and verified. Reopen the camera selector in WhatsApp or your meeting app.' }
          : { ...after, error: 'Repair ran, but camera registration is still incomplete. Restart Windows and check again.' };
      })().catch(error => ({ success: false, canRepair: true, error: error.message })).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
