const { spawnSync } = require('child_process');
const path = require('path');

const CAMERA_NAME = 'Morphly Virtual Camera';
const FILTERS = [
  {
    architecture: '32-bit',
    clsid: '{5C2CD55C-92AD-4999-8666-912BD3E70020}',
    registryView: '32',
    regsvr32: path.join(process.env.WINDIR || 'C:\\Windows', 'SysWOW64', 'regsvr32.exe'),
    file: 'UnityCaptureFilter32.dll'
  },
  {
    architecture: '64-bit',
    clsid: '{5C2CD55C-92AD-4999-8666-912BD3E70010}',
    registryView: '64',
    regsvr32: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'regsvr32.exe'),
    file: 'UnityCaptureFilter64.dll'
  }
];

const command = String(process.argv[2] || 'probe').toLowerCase();
const upstreamInstallDirectory = path.resolve(
  __dirname,
  '..',
  '..',
  'third_party',
  'UnityCapture',
  'Install'
);

function run(executable, args) {
  return spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe'
  });
}

function probeFilter(filter) {
  const key = `HKLM\\SOFTWARE\\Classes\\CLSID\\${filter.clsid}\\InprocServer32`;
  const result = run('reg.exe', ['query', key, '/ve', `/reg:${filter.registryView}`]);
  return result.status === 0;
}

function registerFilter(filter, uninstall = false) {
  const filterPath = path.join(upstreamInstallDirectory, filter.file);
  const args = uninstall
    ? ['/s', '/u', filterPath]
    : ['/s', filterPath, `/i:UnityCaptureName=${CAMERA_NAME}`];
  const result = run(filter.regsvr32, args);

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(
      `${filter.architecture} UnityCapture registration failed with exit code ${result.status}.` +
      `${detail ? ` ${detail}` : ''} Run this command from an Administrator terminal.`
    );
  }
}

try {
  if (command === 'probe') {
    const missing = FILTERS.filter((filter) => !probeFilter(filter));
    if (missing.length > 0) {
      console.error(`Missing UnityCapture registration: ${missing.map((filter) => filter.architecture).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log(`${CAMERA_NAME} is registered for 32-bit and 64-bit applications.`);
    }
  } else if (command === 'install') {
    for (const filter of FILTERS) {
      registerFilter(filter);
    }
    console.log(`${CAMERA_NAME} installed successfully.`);
  } else if (command === 'uninstall') {
    for (const filter of FILTERS) {
      registerFilter(filter, true);
    }
    console.log(`${CAMERA_NAME} removed successfully.`);
  } else {
    console.error('Usage: node scripts/unity-capture-registration.cjs <install|uninstall|probe>');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
