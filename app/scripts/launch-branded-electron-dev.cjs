const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const appDirectory = path.resolve(__dirname, '..');
const electronDirectory = path.join(appDirectory, 'node_modules', 'electron', 'dist');
const sourceExecutable = path.join(electronDirectory, 'electron.exe');
const brandedExecutable = path.join(electronDirectory, 'MorphlyDesktopDev.exe');
const iconPath = path.join(appDirectory, 'build', 'icon.ico');
const appBuilder = path.join(
  appDirectory,
  'node_modules',
  'app-builder-bin',
  'win',
  'x64',
  'app-builder.exe',
);
const sevenZipDirectory = path.join(
  appDirectory,
  'node_modules',
  '7zip-bin',
  'win',
  'x64',
);
const packageConfig = JSON.parse(
  fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'),
);

function getModifiedTime(filePath) {
  return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
}

function findCachedResourceEditor() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const cacheDirectory = path.join(
    localAppData,
    'electron-builder',
    'Cache',
    'winCodeSign',
  );
  if (!fs.existsSync(cacheDirectory)) {
    return null;
  }

  const candidates = fs.readdirSync(cacheDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(cacheDirectory, entry.name, 'rcedit-x64.exe'))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => getModifiedTime(right) - getModifiedTime(left));

  return candidates[0] || null;
}

function prepareBrandedExecutable() {
  for (const requiredPath of [
    sourceExecutable,
    iconPath,
    appBuilder,
    path.join(sevenZipDirectory, '7za.exe'),
  ]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Required local Electron runtime file is missing: ${requiredPath}`);
    }
  }

  const shouldRefresh = !fs.existsSync(brandedExecutable)
    || getModifiedTime(brandedExecutable) < getModifiedTime(sourceExecutable)
    || getModifiedTime(brandedExecutable) < getModifiedTime(iconPath);

  if (!shouldRefresh) {
    return;
  }

  fs.copyFileSync(sourceExecutable, brandedExecutable);

  const resourceArguments = [
    brandedExecutable,
    '--set-icon',
    iconPath,
    '--set-version-string',
    'FileDescription',
    'Morphly Desktop',
    '--set-version-string',
    'ProductName',
    'Morphly Desktop',
    '--set-version-string',
    'CompanyName',
    'Morphly',
    '--set-version-string',
    'InternalName',
    'MorphlyDesktopDev',
    '--set-version-string',
    'OriginalFilename',
    'MorphlyDesktopDev.exe',
    '--set-file-version',
    packageConfig.version,
    '--set-product-version',
    packageConfig.version,
  ];

  const cachedResourceEditor = findCachedResourceEditor();
  let editResult;

  if (cachedResourceEditor) {
    editResult = spawnSync(cachedResourceEditor, resourceArguments, {
      cwd: appDirectory,
      stdio: 'inherit',
      windowsHide: true,
    });
  } else {
    const editorEnvironment = { ...process.env };
    const pathKey = Object.keys(editorEnvironment)
      .find((key) => key.toLowerCase() === 'path') || 'Path';
    editorEnvironment[pathKey] = `${sevenZipDirectory};${editorEnvironment[pathKey] || ''}`;

    editResult = spawnSync(
      appBuilder,
      ['rcedit', '--args', JSON.stringify(resourceArguments)],
      {
        cwd: appDirectory,
        env: editorEnvironment,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
  }

  if (editResult.status !== 0) {
    fs.rmSync(brandedExecutable, { force: true });
    throw new Error(`Unable to apply the Morphly icon to the local Electron runtime (exit ${editResult.status}).`);
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (available) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local Morphly service did not open port ${port}.`);
}

async function ensureService(port, argumentsList) {
  if (await canConnect(port)) {
    return null;
  }

  const serviceEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const service = spawn(sourceExecutable, argumentsList, {
    cwd: appDirectory,
    env: serviceEnvironment,
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForPort(port);
  return service;
}

async function launch() {
  prepareBrandedExecutable();

  const ownedServices = [];
  const apiService = await ensureService(3000, [
    path.join(appDirectory, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(appDirectory, 'server.js'),
  ]);
  if (apiService) ownedServices.push(apiService);

  const rendererService = await ensureService(5173, [
    path.join(appDirectory, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host',
    '127.0.0.1',
  ]);
  if (rendererService) ownedServices.push(rendererService);

  const childEnvironment = { ...process.env };
  childEnvironment.MORPHLY_DESKTOP_DEV = '1';
  delete childEnvironment.ELECTRON_RUN_AS_NODE;

  const electronProcess = spawn(brandedExecutable, [appDirectory], {
    cwd: appDirectory,
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: false,
  });

  const shutdown = () => {
    if (!electronProcess.killed) {
      electronProcess.kill();
    }
    for (const service of ownedServices) {
      if (!service.killed) {
        service.kill();
      }
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, shutdown);
  }

  electronProcess.on('error', (error) => {
    console.error('Unable to launch the branded Morphly Electron runtime:', error);
    process.exitCode = 1;
  });

  electronProcess.on('exit', (code) => {
    for (const service of ownedServices) {
      if (!service.killed) {
        service.kill();
      }
    }
    process.exitCode = code ?? 0;
  });
}

launch().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
