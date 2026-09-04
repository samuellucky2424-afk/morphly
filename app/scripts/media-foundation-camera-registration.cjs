const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REGISTRAR_EXE = 'morphly_cam_registrar.exe';
const BUILD_CONFIGS = ['Release', 'RelWithDebInfo', 'Debug'];

function getRegistrarCandidates(appDirectory = path.resolve(__dirname, '..')) {
  const buildRoot = path.resolve(appDirectory, '..', 'unity-capture-bridge', 'build', 'native-camera');
  return [
    ...BUILD_CONFIGS.map((config) => path.join(buildRoot, config, REGISTRAR_EXE)),
    path.join(buildRoot, REGISTRAR_EXE),
  ];
}

function resolveRegistrar(appDirectory) {
  const match = getRegistrarCandidates(appDirectory).find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to locate ${REGISTRAR_EXE}. Run npm run virtual-camera:build first.`);
  }
  return match;
}

function getRegistrarArgs(command) {
  if (command === 'probe') return ['probe'];
  if (command === 'install') return ['install', '--all-users'];
  if (command === 'uninstall') return ['remove', '--all-users', '--unregister-com'];
  throw new Error('Usage: node scripts/media-foundation-camera-registration.cjs <install|uninstall|probe>');
}

function runRegistration(command, {
  platform = process.platform,
  appDirectory = path.resolve(__dirname, '..'),
  runCommand = spawnSync,
} = {}) {
  if (platform !== 'win32') {
    console.log('Media Foundation camera registration is only required on Windows.');
    return { skipped: true, status: 0 };
  }

  const registrar = resolveRegistrar(appDirectory);
  const result = runCommand(registrar, getRegistrarArgs(command), {
    cwd: path.dirname(registrar),
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'inherit',
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `Media Foundation camera ${command} failed with exit code ${result.status ?? 'unknown'}.`,
      { cause: result.error },
    );
  }

  return { skipped: false, status: result.status };
}

if (require.main === module) {
  try {
    runRegistration(String(process.argv[2] || 'probe').toLowerCase());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  getRegistrarArgs,
  getRegistrarCandidates,
  runRegistration,
};
