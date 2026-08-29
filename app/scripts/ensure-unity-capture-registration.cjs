const path = require('path');
const { spawnSync } = require('child_process');

const REGISTRATION_SCRIPT = path.join(__dirname, 'unity-capture-registration.cjs');

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
    ...options,
  });
}

function formatResultOutput(result) {
  return String(result?.stderr || result?.stdout || '').trim();
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildElevationCommand(nodeExecutable, registrationScript) {
  const argumentLine = `"${registrationScript}" install`;
  return [
    `$registration = Start-Process -FilePath ${quotePowerShellLiteral(nodeExecutable)}`,
    `-ArgumentList ${quotePowerShellLiteral(argumentLine)}`,
    '-Verb RunAs -Wait -PassThru -WindowStyle Hidden',
    '; if ($null -eq $registration) { exit 1 }',
    '; exit $registration.ExitCode',
  ].join(' ');
}

function probeRegistration({ runCommand, nodeExecutable, registrationScript }) {
  return runCommand(nodeExecutable, [registrationScript, 'probe']);
}

function ensureRegistration({
  platform = process.platform,
  nodeExecutable = process.execPath,
  registrationScript = REGISTRATION_SCRIPT,
  runCommand = run,
} = {}) {
  if (platform !== 'win32') {
    console.log('Morphly Virtual Camera registration is only required on Windows.');
    return { elevated: false, skipped: true };
  }

  const initialProbe = probeRegistration({ runCommand, nodeExecutable, registrationScript });
  if (initialProbe.status === 0) {
    console.log('Morphly Virtual Camera is already registered for 32-bit and 64-bit applications.');
    return { elevated: false, skipped: false };
  }

  console.log('Morphly Virtual Camera registration is missing. Windows will request Administrator approval once.');
  const elevationCommand = buildElevationCommand(nodeExecutable, registrationScript);
  const encodedCommand = Buffer.from(elevationCommand, 'utf16le').toString('base64');
  const elevationResult = runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
    { stdio: 'inherit' },
  );

  if (elevationResult.error || elevationResult.status !== 0) {
    const detail = formatResultOutput(elevationResult);
    throw new Error(
      'Morphly Virtual Camera registration was cancelled or failed.'
      + `${detail ? ` ${detail}` : ''}`
      + ' Electron will not start without the required camera registration.',
    );
  }

  const verification = probeRegistration({ runCommand, nodeExecutable, registrationScript });
  if (verification.status !== 0) {
    const detail = formatResultOutput(verification);
    throw new Error(
      'Administrator registration finished, but the 32-bit and 64-bit camera entries could not be verified.'
      + `${detail ? ` ${detail}` : ''}`
      + ' Electron will not start.',
    );
  }

  console.log('Morphly Virtual Camera registration verified for 32-bit and 64-bit applications.');
  return { elevated: true, skipped: false };
}

if (require.main === module) {
  try {
    ensureRegistration();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildElevationCommand,
  ensureRegistration,
};
