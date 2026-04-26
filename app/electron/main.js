import { spawn, spawnSync } from 'child_process';
import { once } from 'events';

import { app, BrowserWindow, systemPreferences, ipcMain, Menu, nativeImage } from 'electron';
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
const VIRTUAL_CAM_REGISTRAR_EXE = 'morphly_cam_registrar.exe';
const VIRTUAL_CAM_REGISTRAR_TIMEOUT_MS = 120000;
const VIRTUAL_CAM_WINDOWS_PROBE_TIMEOUT_MS = 15000;
const VIRTUAL_CAM_FRIENDLY_NAME = 'Morphly G1';
const VIRTUAL_CAM_FRAME_WIDTH = 1280;
const VIRTUAL_CAM_FRAME_HEIGHT = 720;
const VIRTUAL_CAM_FRAME_STRIDE = VIRTUAL_CAM_FRAME_WIDTH * 4;
const VIRTUAL_CAM_FRAME_RATE = 30;
const VIRTUAL_CAM_FRAME_INTERVAL_MS = Math.max(1, Math.floor(1000 / VIRTUAL_CAM_FRAME_RATE));
const VIRTUAL_CAM_FRAME_QUEUE_MAX = 8;
const VIRTUAL_CAM_PIPE_MAGIC = 0x5041434d;
const VIRTUAL_CAM_PIPE_VERSION = 1;
const VIRTUAL_CAM_PIPE_HEADER_BYTES = 40;
const WINDOWS_FILETIME_EPOCH_OFFSET = 116444736000000000n;
const VIRTUAL_CAM_STATS_INTERVAL_MS = 5000;
const VIRTUAL_CAM_BLACK_SAMPLE_PIXELS = 512;

app.disableHardwareAcceleration();

function configureChromiumCachePaths() {
  try {
    const sessionDataPath = path.join(app.getPath('userData'), 'session-data');
    const diskCachePath = path.join(sessionDataPath, 'Cache');
    const gpuCachePath = path.join(sessionDataPath, 'GPUCache');

    fs.mkdirSync(gpuCachePath, { recursive: true });

    app.setPath('sessionData', sessionDataPath);
    app.commandLine.appendSwitch('disk-cache-dir', diskCachePath);
    app.commandLine.appendSwitch('gpu-shader-disk-cache-dir', gpuCachePath);
  } catch (error) {
    console.warn('Unable to configure custom Chromium cache paths:', formatErrorMessage(error));
  }
}

configureChromiumCachePaths();

let mainWindow = null;
let desktopUpdater = null;
let morphlyCamWindow = null;
let morphlyCamPublisher = null;
let virtualCameraEnabled = process.platform === 'win32';

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function getTimestampHundredsOfNs() {
  return (BigInt(Date.now()) * 10000n) + WINDOWS_FILETIME_EPOCH_OFFSET;
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
    `rendererFrames=${controller.stats.rendererFramesReceived} captureFallbacks=${controller.stats.captureFallbacks} ` +
    `captureFailures=${controller.stats.captureFailures} publishFailures=${controller.stats.publishFailures} ` +
    `blackFrames=${controller.stats.blackFrames} size=${VIRTUAL_CAM_FRAME_WIDTH}x${VIRTUAL_CAM_FRAME_HEIGHT} format=BGRA32`
  );
  controller.stats.lastLogAt = now;
}

function isLikelyBlackFrame(frameBytes) {
  if (!frameBytes || frameBytes.length < 4) {
    return true;
  }

  const totalPixels = Math.floor(frameBytes.length / 4);
  const samplePixels = Math.min(totalPixels, VIRTUAL_CAM_BLACK_SAMPLE_PIXELS);
  if (samplePixels === 0) {
    return true;
  }

  const pixelStep = Math.max(1, Math.floor(totalPixels / samplePixels));
  let nonBlackSamples = 0;

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += pixelStep) {
    const byteIndex = pixelIndex * 4;
    const blue = frameBytes[byteIndex];
    const green = frameBytes[byteIndex + 1];
    const red = frameBytes[byteIndex + 2];

    if (blue !== 0 || green !== 0 || red !== 0) {
      nonBlackSamples += 1;
      if (nonBlackSamples >= 4) {
        return false;
      }
    }
  }

  return true;
}

function convertRgbaToBgra(frameBytes) {
  if (!frameBytes || frameBytes.length === 0) {
    return Buffer.alloc(0);
  }

  const bgraBytes = Buffer.allocUnsafe(frameBytes.length);
  for (let index = 0; index < frameBytes.length; index += 4) {
    bgraBytes[index] = frameBytes[index + 2];
    bgraBytes[index + 1] = frameBytes[index + 1];
    bgraBytes[index + 2] = frameBytes[index];
    bgraBytes[index + 3] = frameBytes[index + 3];
  }

  return bgraBytes;
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
    path.resolve(__dirname, '../../native-camera/build/RelWithDebInfo', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../native-camera/build', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build/Debug', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build/Release', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build/RelWithDebInfo', VIRTUAL_CAM_PUBLISHER_EXE),
    path.resolve(__dirname, '../../build', VIRTUAL_CAM_PUBLISHER_EXE)
  ];
}

function getVirtualCameraRegistrarCandidates() {
  if (app.isPackaged) {
    return [
      path.join(process.resourcesPath, 'morphly-cam', VIRTUAL_CAM_REGISTRAR_EXE),
      path.join(process.resourcesPath, VIRTUAL_CAM_REGISTRAR_EXE),
      path.join(path.dirname(process.execPath), VIRTUAL_CAM_REGISTRAR_EXE)
    ];
  }

  return [
    path.resolve(__dirname, '../../native-camera/build/Debug', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../native-camera/build/Release', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../native-camera/build/RelWithDebInfo', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../native-camera/build', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build/Debug', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build/Release', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build/RelWithDebInfo', VIRTUAL_CAM_REGISTRAR_EXE),
    path.resolve(__dirname, '../../build', VIRTUAL_CAM_REGISTRAR_EXE)
  ];
}

function resolveVirtualCameraPublisherPath() {
  const match = getVirtualCameraPublisherCandidates().find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to locate ${VIRTUAL_CAM_PUBLISHER_EXE}. Build it before starting the Electron app.`);
  }

  return match;
}

function resolveVirtualCameraRegistrarPath() {
  const match = getVirtualCameraRegistrarCandidates().find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to locate ${VIRTUAL_CAM_REGISTRAR_EXE}. Build it before starting the Electron app.`);
  }

  return match;
}

function runVirtualCameraRegistrar(registrarPath, args) {
  const result = spawnSync(registrarPath, args, {
    windowsHide: true,
    timeout: VIRTUAL_CAM_REGISTRAR_TIMEOUT_MS,
    encoding: 'utf8'
  });

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  const ok = (result.status ?? 1) === 0 && !result.error;

  if (stdout) {
    console.info(`Morphly cam registrar stdout (${args.join(' ')}):\n${stdout}`);
  }

  if (stderr) {
    console.warn(`Morphly cam registrar stderr (${args.join(' ')}):\n${stderr}`);
  }

  if (result.error) {
    console.error(`Morphly cam registrar execution failed for "${args.join(' ')}":`, result.error);
  }

  if ((result.signal ?? null) !== null) {
    console.warn(`Morphly cam registrar was interrupted by signal ${result.signal} for "${args.join(' ')}".`);
  }

  return {
    ok,
    status: result.status,
    error: result.error,
    stdout,
    stderr
  };
}

function probeWindowsCameraVisibility() {
  if (process.platform !== 'win32') {
    return { supported: false, visible: false };
  }

  const probeScript = [
    `$friendlyName = '${VIRTUAL_CAM_FRIENDLY_NAME}'`,
    '$visible = $false',
    'try {',
    '  $visible = @(Get-PnpDevice -Class Camera -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -eq $friendlyName }).Count -gt 0',
    '} catch {}',
    'if (-not $visible) {',
    '  try {',
    '    $visible = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $friendlyName }).Count -gt 0',
    '  } catch {}',
    '}',
    'if ($visible) {',
    "  Write-Output 'VISIBLE'",
    '  exit 0',
    '}',
    "Write-Output 'MISSING'",
    'exit 2'
  ].join('; ');

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    probeScript
  ], {
    windowsHide: true,
    timeout: VIRTUAL_CAM_WINDOWS_PROBE_TIMEOUT_MS,
    encoding: 'utf8'
  });

  if (result.error) {
    return {
      supported: true,
      visible: false,
      error: formatErrorMessage(result.error)
    };
  }

  const stdout = (result.stdout ?? '').trim();
  const visible = stdout.includes('VISIBLE');

  return {
    supported: true,
    visible,
    stdout,
    stderr: (result.stderr ?? '').trim(),
    status: result.status
  };
}

function ensureVirtualCameraRegistration({ attemptRepair = false } = {}) {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Virtual camera registration is only supported on Windows.' };
  }

  let registrarPath;
  try {
    registrarPath = resolveVirtualCameraRegistrarPath();
  } catch (error) {
    return { success: false, error: formatErrorMessage(error) };
  }

  const probeResult = runVirtualCameraRegistrar(registrarPath, ['probe']);
  if (probeResult.ok) {
    const visibilityResult = probeWindowsCameraVisibility();
    if (visibilityResult.visible) {
      return { success: true, message: 'Morphly virtual camera registration is healthy.', deviceVisible: true };
    }

    if (!attemptRepair) {
      return {
        success: false,
        error: 'Morphly G1 is registered internally, but Windows is not listing it as a camera device.',
        deviceVisible: false
      };
    }

    console.warn('Morphly virtual camera probe succeeded, but Windows camera visibility check failed. Attempting repair...');
  } else if (!attemptRepair) {
    return {
      success: false,
      error: 'Morphly virtual camera is not registered. Run the installer or morphly_cam_registrar install.',
      deviceVisible: false
    };
  }

  const repairReason = probeResult.ok
    ? 'Windows camera visibility check failed'
    : 'virtual camera probe failed';
  console.warn(`Morphly virtual camera ${repairReason}. Attempting automatic registration repair...`);

  const installAllUsersResult = runVirtualCameraRegistrar(registrarPath, ['install', '--all-users']);
  if (!installAllUsersResult.ok) {
    console.warn('All-users registration failed. Retrying current-user registration...');
    const installCurrentUserResult = runVirtualCameraRegistrar(registrarPath, ['install']);
    if (!installCurrentUserResult.ok) {
      return {
        success: false,
        error: 'Unable to register Morphly virtual camera. Please run morphly_cam_registrar install as Administrator.',
        deviceVisible: false
      };
    }
  }

  const reprobeResult = runVirtualCameraRegistrar(registrarPath, ['probe']);
  if (!reprobeResult.ok) {
    return {
      success: false,
      error: 'Morphly virtual camera still failed probe after repair. Please reinstall Morphly Desktop.',
      deviceVisible: false
    };
  }

  const visibilityResult = probeWindowsCameraVisibility();
  if (!visibilityResult.visible) {
    return {
      success: false,
      error: 'Morphly G1 is still not visible to Windows camera apps after repair. WhatsApp will only see the physical webcam until the virtual camera driver is fixed.',
      deviceVisible: false
    };
  }

  return { success: true, message: 'Morphly virtual camera registration repaired successfully.', deviceVisible: true };
}

function createVirtualCameraFrameHeader(payloadBytes, timestampHundredsOfNs = getTimestampHundredsOfNs()) {
  const header = Buffer.alloc(VIRTUAL_CAM_PIPE_HEADER_BYTES);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_MAGIC, 0);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_VERSION, 4);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_WIDTH, 8);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_HEIGHT, 12);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_STRIDE, 16);
  header.writeUInt32LE(VIRTUAL_CAM_FRAME_RATE, 20);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(payloadBytes, 28);
  header.writeBigInt64LE(timestampHundredsOfNs, 32);
  return header;
}

async function writeFrameToVirtualCameraPublisher(controller, frameBytes, timestampHundredsOfNs = getTimestampHundredsOfNs()) {
  if (!controller.child?.stdin || controller.child.stdin.destroyed) {
    throw new Error('Virtual camera publisher process is not writable.');
  }

  const header = createVirtualCameraFrameHeader(frameBytes.length, timestampHundredsOfNs);
  if (!controller.child.stdin.write(header)) {
    await once(controller.child.stdin, 'drain');
  }

  if (!controller.child.stdin.write(frameBytes)) {
    await once(controller.child.stdin, 'drain');
  }
}

async function publishFrameToVirtualCamera(controller, frameBytes, timestampHundredsOfNs, sourceLabel) {
  const expectedBytes = VIRTUAL_CAM_FRAME_STRIDE * VIRTUAL_CAM_FRAME_HEIGHT;
  if (!frameBytes || frameBytes.length !== expectedBytes) {
    throw new Error(`Unexpected ${sourceLabel} frame size: received ${frameBytes?.length ?? 0} bytes, expected ${expectedBytes}.`);
  }

  if (isLikelyBlackFrame(frameBytes)) {
    controller.stats.blackFrames += 1;
    if ((controller.stats.blackFrames % VIRTUAL_CAM_FRAME_RATE) === 0) {
      console.warn(`Morphly cam bridge published a black ${sourceLabel} frame.`);
    }
  }

  await writeFrameToVirtualCameraPublisher(controller, frameBytes, timestampHundredsOfNs);

  controller.stats.framesSent += 1;
  if ((Date.now() - controller.stats.lastLogAt) >= VIRTUAL_CAM_STATS_INTERVAL_MS) {
    logVirtualCameraStats(controller, 'periodic');
  }
}

function updateRendererFrame(controller, payload) {
  if (!controller || controller.stopping || !payload) {
    return;
  }

  const pixels = payload.pixels;
  if (!ArrayBuffer.isView(pixels)) {
    return;
  }

  const srcWidth = payload.width;
  const srcHeight = payload.height;
  const srcStride = payload.stride;

  if (!srcWidth || !srcHeight || !srcStride || pixels.byteLength !== srcStride * srcHeight) {
    return;
  }

  let frameBytes;

  if (srcWidth === VIRTUAL_CAM_FRAME_WIDTH && srcHeight === VIRTUAL_CAM_FRAME_HEIGHT) {
    // Already the right size — use directly.
    const rgbaBytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    frameBytes = convertRgbaToBgra(rgbaBytes);
  } else {
    // Popup renders at a smaller size (e.g. 640x360). Upscale using nativeImage.
    try {
      const srcBuffer = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      const bgraBuffer = convertRgbaToBgra(srcBuffer);
      const img = nativeImage.createFromBuffer(bgraBuffer, { width: srcWidth, height: srcHeight });
      if (img.isEmpty()) {
        return;
      }
      const scaled = img.resize({ width: VIRTUAL_CAM_FRAME_WIDTH, height: VIRTUAL_CAM_FRAME_HEIGHT });
      frameBytes = scaled.toBitmap();
    } catch (e) {
      console.warn('updateRendererFrame: failed to upscale frame:', e.message);
      return;
    }
  }

  const expectedBytes = VIRTUAL_CAM_FRAME_STRIDE * VIRTUAL_CAM_FRAME_HEIGHT;
  if (!frameBytes || frameBytes.length !== expectedBytes) {
    return;
  }

  const rendererFrame = {
    frameBytes,
    timestampHundredsOfNs: getTimestampHundredsOfNs(),
    receivedAt: Date.now(),
    sequence: (controller.rendererFrameSequence ?? 0) + 1
  };
  controller.rendererFrameSequence = rendererFrame.sequence;
  controller.latestRendererFrame = rendererFrame;
  controller.frameQueue.push(rendererFrame);
  while (controller.frameQueue.length > VIRTUAL_CAM_FRAME_QUEUE_MAX) {
    controller.frameQueue.shift();
  }
  controller.stats.rendererFramesReceived += 1;
}

async function publishLatestRendererFrame(controller) {
  if (!controller || controller.stopping || controller.writeInFlight) {
    return;
  }

  const nextBufferedFrame = controller.frameQueue.length > 0
    ? controller.frameQueue.shift()
    : null;
  const frameToPublish = nextBufferedFrame ?? controller.lastPublishedFrame;

  if (!frameToPublish?.frameBytes) {
    return;
  }

  controller.writeInFlight = true;

  try {
    await publishFrameToVirtualCamera(
      controller,
      frameToPublish.frameBytes,
      getTimestampHundredsOfNs(),
      nextBufferedFrame ? 'renderer' : 'cached-renderer'
    );

    controller.lastPublishedFrame = frameToPublish;
    controller.lastPublishedSequence = frameToPublish.sequence ?? controller.lastPublishedSequence;
  } catch (error) {
    controller.stats.publishFailures += 1;
    console.error('Failed to push Morphly output into the virtual camera bridge:', error);

    if (!controller.stopping) {
      const message = formatErrorMessage(error);
      if (message.includes('EPIPE') || message.includes('EOF') || message.includes('not writable')) {
        stopMorphlyCamPublisher();
      }
    }
  } finally {
    controller.writeInFlight = false;
  }
}

function scheduleMorphlyCamPublish(controller, delayMs = 0) {
  if (controller.stopping) {
    return;
  }

  controller.timer = setTimeout(() => {
    controller.timer = null;
    const startedAt = Date.now();
    void publishLatestRendererFrame(controller).finally(() => {
      if (!controller.stopping) {
        const elapsedMs = Date.now() - startedAt;
        scheduleMorphlyCamPublish(controller, Math.max(0, VIRTUAL_CAM_FRAME_INTERVAL_MS - elapsedMs));
      }
    });
  }, delayMs);
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

function ensureMorphlyCamPublisher() {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Virtual camera publishing is only supported on Windows.' };
  }

  if (!virtualCameraEnabled) {
    return { success: false, error: 'Virtual camera publishing is currently disabled.' };
  }

  if (morphlyCamPublisher && !morphlyCamPublisher.stopping) {
    return { success: true, message: 'Morphly cam output is already being published.' };
  }

  stopMorphlyCamPublisher();

  try {
    const publisherPath = resolveVirtualCameraPublisherPath();
    const child = spawn(publisherPath, [], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });

    const controller = {
      child,
      timer: null,
      writeInFlight: false,
      stopping: false,
      latestRendererFrame: null,
      frameQueue: [],
      lastPublishedFrame: null,
      rendererFrameSequence: 0,
      lastPublishedSequence: 0,
      stats: {
        startedAt: Date.now(),
        lastLogAt: Date.now(),
        framesSent: 0,
        rendererFramesReceived: 0,
        captureFallbacks: 0,
        captureFailures: 0,
        publishFailures: 0,
        blackFrames: 0
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
    scheduleMorphlyCamPublish(controller);

    return { success: true, message: `Publishing Morphly cam output via ${publisherPath}.` };
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
  });

  const startResult = ensureMorphlyCamPublisher();
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

  mainWindow.webContents.once('did-finish-load', () => {
    if (!virtualCameraEnabled || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const startResult = ensureMorphlyCamPublisher();
    if (!startResult.success) {
      console.error('Main-window virtual camera bridge did not start:', startResult.error ?? startResult.message);
    }
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

    const registrationResult = ensureVirtualCameraRegistration({ attemptRepair: true });
    if (!registrationResult.success) {
      return registrationResult;
    }

    return ensureMorphlyCamPublisher();
  });

  ipcMain.handle('virtual-camera:stop', async () => {
    virtualCameraEnabled = false;
    return stopMorphlyCamPublisher();
  });

  ipcMain.on('virtual-camera:push-frame', (event, payload) => {
    const fromMain = mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id;
    if (!fromMain) {
      return;
    }

    if (!morphlyCamPublisher || morphlyCamPublisher.stopping) {
      return;
    }

    updateRendererFrame(morphlyCamPublisher, payload);
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
