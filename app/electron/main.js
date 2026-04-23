import { spawn } from 'child_process';
import { once } from 'events';

import { app, BrowserWindow, systemPreferences, ipcMain, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import { createDesktopUpdater } from './updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDevelopment = !app.isPackaged && process.env.NODE_ENV !== 'production';
const RELEASES_URL = 'https://github.com/samuellucky2424-afk/morphly/releases';
const MORPHLY_CAM_WINDOW_NAME = 'Morphly cam';
const MORPHLY_CAM_WINDOW_WIDTH = 640;
const MORPHLY_CAM_WINDOW_HEIGHT = 360;
const VIRTUAL_CAM_PUBLISHER_EXE = 'morphly_cam_pipe_publisher.exe';
const VIRTUAL_CAM_FRAME_WIDTH = 1280;
const VIRTUAL_CAM_FRAME_HEIGHT = 720;
const VIRTUAL_CAM_FRAME_STRIDE = VIRTUAL_CAM_FRAME_WIDTH * 4;
const VIRTUAL_CAM_FRAME_RATE = 30;
const VIRTUAL_CAM_FRAME_INTERVAL_MS = Math.max(1, Math.floor(1000 / VIRTUAL_CAM_FRAME_RATE));
const VIRTUAL_CAM_PIPE_MAGIC = 0x5041434d;
const VIRTUAL_CAM_PIPE_VERSION = 1;
const VIRTUAL_CAM_PIPE_HEADER_BYTES = 40;
const WINDOWS_FILETIME_EPOCH_OFFSET = 116444736000000000n;
const VIRTUAL_CAM_STATS_INTERVAL_MS = 5000;

app.disableHardwareAcceleration();

let mainWindow = null;
let desktopUpdater = null;
let morphlyCamWindow = null;
let morphlyCamPublisher = null;
let virtualCameraEnabled = process.platform === 'win32';

function isVirtualCameraTestModeEnabled() {
  return process.env.MORPHLY_VCAM_TEST_MODE === '1';
}

function logVirtualCameraStats(controller, reason) {
  if (!controller?.stats) {
    return;
  }

  const now = Date.now();
  const elapsedMs = Math.max(1, now - controller.stats.startedAt);
  const fps = (controller.stats.framesSent * 1000) / elapsedMs;
  console.info(
    `Morphly cam bridge stats (${reason}): frames=${controller.stats.framesSent} fps=${fps.toFixed(2)} ` +
    `captureFailures=${controller.stats.captureFailures} publishFailures=${controller.stats.publishFailures} ` +
    `size=${VIRTUAL_CAM_FRAME_WIDTH}x${VIRTUAL_CAM_FRAME_HEIGHT} format=BGRA32`
  );
  controller.stats.lastLogAt = now;
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function getVirtualCameraPublisherCandidates() {
  if (app.isPackaged) {
    return [
      path.join(process.resourcesPath, 'morphly-cam', VIRTUAL_CAM_PUBLISHER_EXE),
      path.join(process.resourcesPath, VIRTUAL_CAM_PUBLISHER_EXE),
      path.join(path.dirname(process.execPath), VIRTUAL_CAM_PUBLISHER_EXE)
    ];
  }

  return [
    path.resolve(__dirname, '../../native-camera/build/Debug', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../native-camera/build/Release', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../native-camera/build', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../../build/Debug', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../../build/Release', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../../build', VIRTUAL_CAM_PUBLISHER_EXE)
  ];
}

function resolveVirtualCameraPublisherPath() {
  const match = getVirtualCameraPublisherCandidates().find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to locate ${VIRTUAL_CAM_PUBLISHER_EXE}. Build it before starting the Electron app.`);
  }

  return match;
}

function createVirtualCameraFrameHeader(payloadBytes) {
  const header = Buffer.alloc(VIRTUAL_CAM_PIPE_HEADER_BYTES);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_MAGIC, 0);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_VERSION, 4);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_WIDTH, 8);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_HEIGHT, 12);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_STRIDE, 16);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_RATE, 20);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(payloadBytes, 28);
  header.writeBigInt64LE((BigInt(Date.now()) * 10000n) + WINDOWS_FILETIME_EPOCH_OFFSET, 32);
  return header;
}

async function writeFrameToVirtualCameraPublisher(controller, frameBytes) {
  if (!controller.child?.stdin || controller.child.stdin.destroyed) {
    throw new Error('Virtual camera publisher process is not writable.');
  }

  const header = createVirtualCameraFrameHeader(frameBytes.length);
  if (!controller.child.stdin.write(header)) {
    await once(controller.child.stdin, 'drain');
  }

  if (!controller.child.stdin.write(frameBytes)) {
    await once(controller.child.stdin, 'drain');
  }

  controller.stats.framesSent += 1;
  if ((Date.now() - controller.stats.lastLogAt) >= VIRTUAL_CAM_STATS_INTERVAL_MS) {
    logVirtualCameraStats(controller, 'periodic');
  }
}

function scheduleMorphlyCamCapture(controller, delayMs = 0) {
  if (controller.stopping) {
    return;
  }

  controller.timer = setTimeout(() => {
    controller.timer = null;
    void captureMorphlyCamFrame(controller);
  }, delayMs);
}

async function captureMorphlyCamFrame(controller) {
  if (controller.stopping || controller.captureInFlight) {
    return;
  }

  const popupWindow = controller.window;
  if (!popupWindow || popupWindow.isDestroyed() || popupWindow.webContents.isDestroyed()) {
    stopMorphlyCamPublisher();
    return;
  }

  controller.captureInFlight = true;
  const startedAt = Date.now();

  try {
    const capturedImage = await popupWindow.webContents.capturePage();
    if (!controller.stopping && !capturedImage.isEmpty()) {
      const frameImage = capturedImage.resize({
        width: VIRTUAL_CAM_FRAME_WIDTH,
        height: VIRTUAL_CAM_FRAME_HEIGHT,
        quality: 'best'
      });

      const frameBytes = frameImage.toBitmap();
      const expectedBytes = VIRTUAL_CAM_FRAME_STRIDE * VIRTUAL_CAM_FRAME_HEIGHT;
      if (frameBytes.length !== expectedBytes) {
        throw new Error(`Unexpected capture size: received ${frameBytes.length} bytes, expected ${expectedBytes}.`);
      }

      await writeFrameToVirtualCameraPublisher(controller, frameBytes);
    }
  } catch (error) {
    controller.stats.captureFailures += 1;
    console.error('Failed to push Morphly cam output into the virtual camera bridge:', error);

    if (!controller.stopping) {
      const message = formatErrorMessage(error);
      if (message.includes('EPIPE') || message.includes('EOF') || message.includes('not writable')) {
        controller.stats.publishFailures += 1;
        stopMorphlyCamPublisher();
        return;
      }
    }
  } finally {
    controller.captureInFlight = false;
  }

  if (!controller.stopping) {
    const elapsedMs = Date.now() - startedAt;
    scheduleMorphlyCamCapture(controller, Math.max(0, VIRTUAL_CAM_FRAME_INTERVAL_MS - elapsedMs));
  }
}

function stopMorphlyCamPublisher() {
  if (!morphlyCamPublisher) {
    return { success: true, message: 'Virtual camera publisher is already stopped.' };
  }

  const controller = morphlyCamPublisher;
  morphlyCamPublisher = null;
  controller.stopping = true;

  if (controller.timer) {
    clearTimeout(controller.timer);
    controller.timer = null;
  }

  if (controller.stats?.framesSent) {
    logVirtualCameraStats(controller, 'stop');
  }

  if (controller.child?.stdin && !controller.child.stdin.destroyed) {
    controller.child.stdin.end();
  }

  if (controller.child && !controller.child.killed) {
    const killTimer = setTimeout(() => {
      if (!controller.child.killed) {
        controller.child.kill();
      }
    }, 1000);
    killTimer.unref?.();

    controller.child.once('exit', () => {
      clearTimeout(killTimer);
    });
  }

  return { success: true, message: 'Virtual camera publisher stopped.' };
}

function ensureMorphlyCamPublisher(window) {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Virtual camera publishing is only supported on Windows.' };
  }

  if (!virtualCameraEnabled) {
    return { success: false, error: 'Virtual camera publishing is currently disabled.' };
  }

  if (!window || window.isDestroyed()) {
    return { success: false, error: 'Morphly cam window is not available yet.' };
  }

  if (morphlyCamPublisher?.window === window && !morphlyCamPublisher.stopping) {
    return { success: true, message: 'Morphly cam output is already being published.' };
  }

  stopMorphlyCamPublisher();

  try {
    const publisherPath = resolveVirtualCameraPublisherPath();
    const spawnArgs = isVirtualCameraTestModeEnabled()
      ? ['--test', '--width', String(VIRTUAL_CAM_FRAME_WIDTH), '--height', String(VIRTUAL_CAM_FRAME_HEIGHT), '--fps', String(VIRTUAL_CAM_FRAME_RATE)]
      : [];
    const child = spawn(publisherPath, spawnArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });

    const controller = {
      child,
      window,
      timer: null,
      captureInFlight: false,
      stopping: false,
      stats: {
        startedAt: Date.now(),
        lastLogAt: Date.now(),
        framesSent: 0,
        captureFailures: 0,
        publishFailures: 0
      }
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.error(`Morphly cam publisher: ${message}`);
      }
    });

    child.stdin?.on('error', (error) => {
      if (!controller.stopping) {
        console.error('Virtual camera publisher stdin failed:', error);
        stopMorphlyCamPublisher();
      }
    });

    child.on('error', (error) => {
      if (!controller.stopping) {
        console.error('Failed to launch the virtual camera publisher:', error);
        stopMorphlyCamPublisher();
      }
    });

    child.on('exit', (code, signal) => {
      if (morphlyCamPublisher === controller) {
        morphlyCamPublisher = null;
      }

      if (!controller.stopping) {
        console.error(`Virtual camera publisher exited unexpectedly with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`);
      }
    });

    morphlyCamPublisher = controller;
    if (!isVirtualCameraTestModeEnabled()) {
      scheduleMorphlyCamCapture(controller);
    }

    return {
      success: true,
      message: isVirtualCameraTestModeEnabled()
        ? `Publishing virtual camera test frames via ${publisherPath}.`
        : `Publishing Morphly cam output via ${publisherPath}.`
    };
  } catch (error) {
    console.error('Unable to start the virtual camera publisher:', error);
    return { success: false, error: formatErrorMessage(error) };
  }
}

function loadEnvironmentVariables() {
  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '../.env');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

function resolveUpdateManifestUrl() {
  return process.env.MORPHLY_UPDATE_MANIFEST_URL
    || process.env.VITE_UPDATE_MANIFEST_URL
    || 'https://morphly-alpha.vercel.app/api/version';
}

function resolveRendererDevUrl() {
  return process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';
}

function isMorphlyCamPopup(details) {
  return details.frameName === MORPHLY_CAM_WINDOW_NAME;
}

function createMorphlyCamWindowOptions() {
  return {
    title: MORPHLY_CAM_WINDOW_NAME,
    width: MORPHLY_CAM_WINDOW_WIDTH,
    height: MORPHLY_CAM_WINDOW_HEIGHT,
    minWidth: 360,
    minHeight: 220,
    backgroundColor: '#000000',
    transparent: false,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    fullscreenable: false,
    parent: mainWindow ?? undefined,
    webPreferences: {
      offscreen: false,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };
}

function keepWindowVisibleOnTop(window) {
  if (window.isDestroyed()) {
    return;
  }

  window.setMenuBarVisibility(false);

  if (typeof window.moveTop === 'function') {
    window.moveTop();
  }
}

function configureMorphlyCamPopup(window) {
  keepWindowVisibleOnTop(window);
  window.setTitle(MORPHLY_CAM_WINDOW_NAME);
  window.webContents.setFrameRate(30);

  window.on('show', () => {
    keepWindowVisibleOnTop(window);
  });

  window.on('focus', () => {
    keepWindowVisibleOnTop(window);
  });

  window.on('blur', () => {
    keepWindowVisibleOnTop(window);
  });

  window.on('closed', () => {
    if (morphlyCamWindow === window) {
      morphlyCamWindow = null;
    }

    if (morphlyCamPublisher?.window === window) {
      stopMorphlyCamPublisher();
    }
  });

  const startResult = ensureMorphlyCamPublisher(window);
  if (!startResult.success) {
    console.error('Morphly cam virtual camera bridge did not start:', startResult.error ?? startResult.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isMorphlyCamPopup(details)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: createMorphlyCamWindowOptions()
      };
    }

    return { action: 'allow' };
  });
  mainWindow.webContents.on('did-create-window', (window, details) => {
    if (isMorphlyCamPopup(details)) {
      morphlyCamWindow = window;
      configureMorphlyCamPopup(window);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  if (isDevelopment) {
    void mainWindow.loadURL(resolveRendererDevUrl());
  } else {
    const packagedIndexHtml = path.resolve(app.getAppPath(), 'dist', 'index.html');
    void mainWindow.loadFile(packagedIndexHtml);

    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      });
    }
  }
}

function registerVirtualCameraHandlers() {
  ipcMain.handle('virtual-camera:start', async () => {
    virtualCameraEnabled = true;

    if (!morphlyCamWindow || morphlyCamWindow.isDestroyed()) {
      return {
        success: true,
        message: 'Virtual camera bridge armed. Open Morphly cam to begin publishing frames.'
      };
    }

    return ensureMorphlyCamPublisher(morphlyCamWindow);
  });

  ipcMain.handle('virtual-camera:stop', async () => {
    virtualCameraEnabled = false;
    return stopMorphlyCamPublisher();
  });
}

function registerUpdaterHandlers() {
  ipcMain.handle('get-update-state', async () => desktopUpdater?.getStateSnapshot() ?? null);

  ipcMain.handle('check-for-updates', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.checkForUpdates('ipc');
  });

  ipcMain.handle('download-update', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.downloadUpdate('ipc');
  });

  ipcMain.handle('install-update', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.installUpdate('ipc');
  });

  ipcMain.handle('open-release-page', async () => {
    if (!desktopUpdater) {
      return { success: false, error: 'Updater not initialized.' };
    }
    return desktopUpdater.openReleasePage('ipc', true);
  });
}

app.whenReady().then(async () => {
  loadEnvironmentVariables();

  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera');
  }

  registerVirtualCameraHandlers();

  desktopUpdater = createDesktopUpdater({
    manifestUrl: resolveUpdateManifestUrl(),
    releasePageUrl: RELEASES_URL,
    logPath: path.join(app.getPath('userData'), 'updater.log'),
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    sendState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop-updater:state', state);
      }
    }
  });

  registerUpdaterHandlers();
  createWindow();
  desktopUpdater.startBackgroundChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopMorphlyCamPublisher();

  if (desktopUpdater) {
    desktopUpdater.dispose();
  }
});

process.on('uncaughtException', (error) => {
  console.error('uncaughtException in Electron main process:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection in Electron main process:', reason);
});
