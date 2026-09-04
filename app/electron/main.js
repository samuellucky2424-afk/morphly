import { spawn } from 'child_process';
import { once } from 'events';

import { app, BrowserWindow, systemPreferences, ipcMain, Menu, nativeImage, clipboard, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import { createDesktopUpdater } from './updater.js';
import { validateCameraSelectionForTrustedProcess } from './camera-validation.js';
import { selectVirtualCameraProfile } from './virtual-camera-profile.js';
import { loadMorphlyEnvironment } from '../shared/load-environment.js';
import { createMeanVcRuntimeController } from '../server/meanvc-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// The branded development launcher runs a renamed electron.exe. Electron treats
// that executable as packaged, so use the launcher's explicit marker as the
// source of truth for development-only paths and behaviour.
const isDevelopment = process.env.MORPHLY_DESKTOP_DEV === '1'
  || (!app.isPackaged && process.env.NODE_ENV !== 'production');
const isPackagedRuntime = app.isPackaged && !isDevelopment;
const RELEASES_URL = 'https://github.com/samuellucky2424-afk/morphly/releases';
const MORPHLY_CAM_WINDOW_NAME = 'Morphly cam';
const MORPHLY_CAM_WINDOW_WIDTH = 640;
const MORPHLY_CAM_WINDOW_HEIGHT = 360;
const UNITY_CAPTURE_SENDER_EXE = 'morphly_unity_capture_sender.exe';
const UNITY_CAPTURE_REGISTRY_TIMEOUT_MS = 5000;
const MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE = 'morphly_cam_registrar.exe';
const MEDIA_FOUNDATION_CAMERA_REGISTRAR_TIMEOUT_MS = 120000;
const UNITY_CAPTURE_NAME = 'Morphly Virtual Camera';
const VIDEO_INPUT_DEVICE_CATEGORY = '{860BB310-5D01-11d0-BD3B-00A0C911CE86}';
const UNITY_CAPTURE_FILTERS = [
  {
    clsid: '{5C2CD55C-92AD-4999-8666-912BD3E70020}',
    registryView: '32',
    file: 'UnityCaptureFilter32.dll'
  },
  {
    clsid: '{5C2CD55C-92AD-4999-8666-912BD3E70010}',
    registryView: '64',
    file: 'UnityCaptureFilter64.dll'
  }
];
const VIRTUAL_CAM_RECEIVER_PROBE_INTERVAL_MS = 500;
const VIRTUAL_CAM_PIPE_MAGIC = 0x5041434d;
const VIRTUAL_CAM_PIPE_VERSION = 1;
const VIRTUAL_CAM_PIPE_HEADER_BYTES = 40;
const WINDOWS_FILETIME_EPOCH_OFFSET = 116444736000000000n;
const VIRTUAL_CAM_STATS_INTERVAL_MS = 5000;
const VIRTUAL_CAM_BLACK_SAMPLE_PIXELS = 512;

app.setName('Morphly Desktop');
loadEnvironmentVariables();

const VIRTUAL_CAM_PROFILE = selectVirtualCameraProfile();

if (process.env.MORPHLY_DISABLE_HARDWARE_ACCELERATION === '1') {
  app.disableHardwareAcceleration();
  console.warn('Morphly hardware acceleration disabled by MORPHLY_DISABLE_HARDWARE_ACCELERATION.');
} else {
  console.info('Morphly hardware acceleration enabled for realtime video rendering.');
}

function configureChromiumCachePaths() {
  try {
    const userDataPath = app.getPath('userData');
    const diskCachePath = path.join(userDataPath, 'Cache');
    const gpuCachePath = path.join(userDataPath, 'GPUCache');

    fs.mkdirSync(diskCachePath, { recursive: true });
    fs.mkdirSync(gpuCachePath, { recursive: true });

    app.commandLine.appendSwitch('disk-cache-dir', diskCachePath);
    app.commandLine.appendSwitch('gpu-shader-disk-cache-dir', gpuCachePath);
  } catch (error) {
    console.warn('Unable to configure custom Chromium cache paths:', formatErrorMessage(error));
  }
}

configureChromiumCachePaths();

let mainWindow = null;
let desktopUpdater = null;
let morphlyVcRuntime = null;
let morphlyCamWindow = null;
let morphlyCamPublisher = null;
let virtualCameraEnabled = process.platform === 'win32';
let virtualCameraOperationGeneration = 0;

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function sendVirtualCameraReceiverState(connected) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('virtual-camera:receiver-state', {
    connected,
    profile: VIRTUAL_CAM_PROFILE
  });
}

function setVirtualCameraReceiverState(controller, connected) {
  if (
    controller.stopping
    || morphlyCamPublisher !== controller
    || controller.receiverReady === connected
  ) {
    return;
  }

  controller.receiverReady = connected;
  sendVirtualCameraReceiverState(connected);
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
    `droppedFrames=${controller.stats.rendererFramesDropped} receiverProbes=${controller.stats.receiverProbes} ` +
    `blackFrames=${controller.stats.blackFrames} profile=${controller.profile.mode} ` +
    `size=${controller.profile.width}x${controller.profile.height}@${controller.profile.frameRate} format=RGBA8`
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

function swapRedAndBlueChannels(frameBytes) {
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

function getUnityCaptureSenderCandidates() {
  if (isPackagedRuntime) {
    return [
      path.join(process.resourcesPath, 'unity-capture', UNITY_CAPTURE_SENDER_EXE),
      path.join(process.resourcesPath, UNITY_CAPTURE_SENDER_EXE),
      path.join(path.dirname(process.execPath), UNITY_CAPTURE_SENDER_EXE)
    ];
  }

  return [
    path.resolve(__dirname, '../../unity-capture-bridge/build/Debug', UNITY_CAPTURE_SENDER_EXE),
    path.resolve(__dirname, '../../unity-capture-bridge/build/Release', UNITY_CAPTURE_SENDER_EXE),
    path.resolve(__dirname, '../../unity-capture-bridge/build/RelWithDebInfo', UNITY_CAPTURE_SENDER_EXE),
    path.resolve(__dirname, '../../unity-capture-bridge/build', UNITY_CAPTURE_SENDER_EXE)
  ];
}

function resolveUnityCaptureSenderPath() {
  const match = getUnityCaptureSenderCandidates().find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(`Unable to locate ${UNITY_CAPTURE_SENDER_EXE}. Run npm run virtual-camera:build first.`);
  }

  return match;
}

function getMediaFoundationCameraRegistrarCandidates() {
  if (isPackagedRuntime) {
    return [
      path.join(
        process.resourcesPath,
        'media-foundation-camera',
        MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE,
      ),
      path.join(process.resourcesPath, MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE),
      path.join(path.dirname(process.execPath), MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE),
    ];
  }

  return [
    path.resolve(
      __dirname,
      '../../unity-capture-bridge/build/native-camera/Debug',
      MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE,
    ),
    path.resolve(
      __dirname,
      '../../unity-capture-bridge/build/native-camera/Release',
      MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE,
    ),
    path.resolve(
      __dirname,
      '../../unity-capture-bridge/build/native-camera/RelWithDebInfo',
      MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE,
    ),
    path.resolve(
      __dirname,
      '../../unity-capture-bridge/build/native-camera',
      MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE,
    ),
  ];
}

function resolveMediaFoundationCameraRegistrarPath() {
  const match = getMediaFoundationCameraRegistrarCandidates()
    .find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(
      `Unable to locate ${MEDIA_FOUNDATION_CAMERA_REGISTRAR_EXE}. ` +
      'Run npm run virtual-camera:build first.',
    );
  }

  return match;
}

function runMediaFoundationCameraRegistrar(args) {
  return new Promise((resolve) => {
    let registrarPath;
    try {
      registrarPath = resolveMediaFoundationCameraRegistrarPath();
    } catch (error) {
      resolve({ ok: false, status: null, stdout: '', stderr: '', error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout = null;
    const child = spawn(registrarPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...result,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      finish({ ok: false, status: null, error });
    });
    child.once('close', (status, signal) => {
      finish({
        ok: status === 0 && !signal,
        status,
        signal,
        error: null,
      });
    });

    timeout = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        status: null,
        error: new Error(
          `Media Foundation camera probe timed out after ` +
          `${MEDIA_FOUNDATION_CAMERA_REGISTRAR_TIMEOUT_MS}ms.`,
        ),
      });
    }, MEDIA_FOUNDATION_CAMERA_REGISTRAR_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function queryRegistryString(registryKey, valueName, registryView) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout = null;
    const valueArgs = valueName ? ['/v', valueName] : ['/ve'];
    const child = spawn('reg.exe', ['query', registryKey, ...valueArgs, `/reg:${registryView}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      resolve({
        ...result,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        registryView
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.once('error', (error) => {
      finish({ ok: false, status: null, error });
    });

    child.once('close', (status) => {
      finish({
        ok: status === 0,
        status,
        error: null
      });
    });

    timeout = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        status: null,
        error: new Error(`UnityCapture registry probe timed out after ${UNITY_CAPTURE_REGISTRY_TIMEOUT_MS}ms.`)
      });
    }, UNITY_CAPTURE_REGISTRY_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function parseRegistryString(stdout) {
  const match = String(stdout || '').match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/mi);
  return match ? match[1].trim().replace(/^"|"$/g, '') : null;
}

function normalizeWindowsPath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+/g, '\\').toLowerCase();
}

function getExpectedUnityCaptureFilterPath(filter) {
  if (isPackagedRuntime) {
    return path.join(process.resourcesPath, 'unity-capture', filter.file);
  }

  return path.resolve(__dirname, '../../third_party/UnityCapture/Install', filter.file);
}

async function queryUnityCaptureRegistration(filter) {
  const clsidKey = `HKLM\\SOFTWARE\\Classes\\CLSID\\${filter.clsid}`;
  const categoryKey = `HKLM\\SOFTWARE\\Classes\\CLSID\\${VIDEO_INPUT_DEVICE_CATEGORY}\\Instance\\${filter.clsid}`;
  const expectedFilterPath = getExpectedUnityCaptureFilterPath(filter);
  const [nameResult, pathResult, categoryNameResult, categoryClsidResult] = await Promise.all([
    queryRegistryString(clsidKey, null, filter.registryView),
    queryRegistryString(`${clsidKey}\\InprocServer32`, null, filter.registryView),
    queryRegistryString(categoryKey, 'FriendlyName', filter.registryView),
    queryRegistryString(categoryKey, 'CLSID', filter.registryView)
  ]);
  const registeredFilterPath = parseRegistryString(pathResult.stdout);
  const ok = nameResult.ok
    && pathResult.ok
    && categoryNameResult.ok
    && categoryClsidResult.ok
    && parseRegistryString(nameResult.stdout) === UNITY_CAPTURE_NAME
    && parseRegistryString(categoryNameResult.stdout) === UNITY_CAPTURE_NAME
    && String(parseRegistryString(categoryClsidResult.stdout) || '').toLowerCase() === filter.clsid.toLowerCase()
    && normalizeWindowsPath(registeredFilterPath) === normalizeWindowsPath(expectedFilterPath)
    && fs.existsSync(expectedFilterPath);

  return { ok, registryView: filter.registryView };
}

async function ensureUnityCaptureRegistration() {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Virtual camera registration is only supported on Windows.' };
  }

  const probeResults = await Promise.all(UNITY_CAPTURE_FILTERS.map(queryUnityCaptureRegistration));
  const missingViews = probeResults
    .filter((result) => !result.ok)
    .map((result) => `${result.registryView}-bit`);
  if (missingViews.length > 0) {
    return {
      success: false,
      error: `Morphly Virtual Camera is not registered for ${missingViews.join(' and ')} applications. Reinstall Morphly Desktop as Administrator.`
    };
  }

  return { success: true, message: 'The upstream UnityCapture filters are registered.' };
}

async function ensureMediaFoundationCameraRegistration() {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Media Foundation camera registration is only supported on Windows.' };
  }

  const probeResult = await runMediaFoundationCameraRegistrar(['probe']);
  if (probeResult.ok) {
    return { success: true, message: 'The WhatsApp-compatible Media Foundation camera is registered.' };
  }

  const detail = probeResult.stderr || probeResult.stdout || formatErrorMessage(probeResult.error);
  return {
    success: false,
    error:
      'Morphly Virtual Camera is not registered for WhatsApp and modern Windows apps. ' +
      `Reinstall Morphly Desktop as Administrator.${detail ? ` ${detail}` : ''}`,
  };
}

async function ensureVirtualCameraRegistration() {
  const [unityCaptureResult, mediaFoundationResult] = await Promise.all([
    ensureUnityCaptureRegistration(),
    ensureMediaFoundationCameraRegistration(),
  ]);

  if (!unityCaptureResult.success) return unityCaptureResult;
  if (!mediaFoundationResult.success) return mediaFoundationResult;
  return {
    success: true,
    message: 'Morphly Virtual Camera is registered for legacy and modern Windows camera apps.',
  };
}

function createVirtualCameraFrameHeader(profile, payloadBytes, timestampHundredsOfNs = getTimestampHundredsOfNs()) {
  const header = Buffer.alloc(VIRTUAL_CAM_PIPE_HEADER_BYTES);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_MAGIC, 0);
  header.writeUInt32LE(VIRTUAL_CAM_PIPE_VERSION, 4);
  header.writeUInt32LE(profile.width, 8);
  header.writeUInt32LE(profile.height, 12);
  header.writeUInt32LE(profile.width * 4, 16);
  header.writeUInt32LE(profile.frameRate, 20);
  header.writeUInt32LE(1, 24);
  header.writeUInt32LE(payloadBytes, 28);
  header.writeBigInt64LE(timestampHundredsOfNs, 32);
  return header;
}

async function writeFrameToVirtualCameraPublisher(controller, frameBytes, timestampHundredsOfNs = getTimestampHundredsOfNs()) {
  if (!controller.child?.stdin || controller.child.stdin.destroyed) {
    throw new Error('Virtual camera publisher process is not writable.');
  }

  const header = createVirtualCameraFrameHeader(controller.profile, frameBytes.length, timestampHundredsOfNs);
  if (!controller.child.stdin.write(header)) {
    await once(controller.child.stdin, 'drain');
  }

  if (!controller.child.stdin.write(frameBytes)) {
    await once(controller.child.stdin, 'drain');
  }
}

async function publishFrameToVirtualCamera(controller, frameBytes, timestampHundredsOfNs, sourceLabel) {
  const expectedBytes = controller.profile.width * controller.profile.height * 4;
  if (!frameBytes || frameBytes.length !== expectedBytes) {
    throw new Error(`Unexpected ${sourceLabel} frame size: received ${frameBytes?.length ?? 0} bytes, expected ${expectedBytes}.`);
  }

  if (isLikelyBlackFrame(frameBytes)) {
    controller.stats.blackFrames += 1;
    if ((controller.stats.blackFrames % controller.profile.frameRate) === 0) {
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

  if (srcWidth === controller.profile.width && srcHeight === controller.profile.height) {
    // Retain the IPC-owned backing store without another full-frame copy.
    frameBytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  } else {
    // Keep the bridge tolerant of an in-flight renderer profile update.
    try {
      const srcBuffer = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      const bgraBuffer = swapRedAndBlueChannels(srcBuffer);
      const img = nativeImage.createFromBuffer(bgraBuffer, { width: srcWidth, height: srcHeight });
      if (img.isEmpty()) {
        return;
      }
      const scaled = img.resize({ width: controller.profile.width, height: controller.profile.height });
      frameBytes = swapRedAndBlueChannels(scaled.toBitmap());
    } catch (e) {
      console.warn('updateRendererFrame: failed to resize frame:', e.message);
      return;
    }
  }

  const expectedBytes = controller.profile.width * controller.profile.height * 4;
  if (!frameBytes || frameBytes.length !== expectedBytes) {
    return;
  }

  const rendererFrame = {
    frameBytes,
    timestampHundredsOfNs: getTimestampHundredsOfNs(),
    receivedAt: Date.now(),
    sequence: (controller.rendererFrameSequence ?? 0) + 1
  };
  if (
    controller.latestRendererFrame?.sequence > controller.lastPublishedSequence &&
    controller.latestRendererFrame?.sequence !== controller.frameBeingPublishedSequence
  ) {
    controller.stats.rendererFramesDropped += 1;
  }

  controller.rendererFrameSequence = rendererFrame.sequence;
  controller.latestRendererFrame = rendererFrame;
  controller.stats.rendererFramesReceived += 1;
}

async function publishLatestRendererFrame(controller) {
  if (!controller || controller.stopping || controller.writeInFlight) {
    return;
  }

  const now = Date.now();
  const latestFrame = controller.latestRendererFrame;
  const hasFreshFrame = latestFrame?.sequence > controller.lastPublishedSequence;
  const receiverProbeDue = controller.receiverReady === false &&
    (now - controller.lastReceiverProbeAt) >= VIRTUAL_CAM_RECEIVER_PROBE_INTERVAL_MS;
  const keepAliveDue = controller.receiverReady !== false && controller.lastPublishedFrame &&
    (now - controller.lastPublishedAt) >= VIRTUAL_CAM_RECEIVER_PROBE_INTERVAL_MS;

  const frameToPublish = hasFreshFrame
    ? latestFrame
    : (receiverProbeDue || keepAliveDue ? controller.lastPublishedFrame : null);

  if (!frameToPublish?.frameBytes) {
    return;
  }

  controller.writeInFlight = true;
  controller.frameBeingPublishedSequence = frameToPublish.sequence;
  if (receiverProbeDue) {
    controller.lastReceiverProbeAt = now;
    controller.stats.receiverProbes += 1;
  }

  try {
    await publishFrameToVirtualCamera(
      controller,
      frameToPublish.frameBytes,
      getTimestampHundredsOfNs(),
      hasFreshFrame ? 'renderer' : (receiverProbeDue ? 'receiver-probe' : 'cached-renderer')
    );

    controller.lastPublishedFrame = frameToPublish;
    controller.lastPublishedSequence = frameToPublish.sequence ?? controller.lastPublishedSequence;
    controller.lastPublishedAt = Date.now();
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
    controller.frameBeingPublishedSequence = null;
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
        // Media Foundation consumers (including WhatsApp) read the shared
        // frame bridge without opening the legacy DirectShow receiver. Keep
        // polling at the configured frame rate so fresh renderer frames reach
        // both camera paths even while DirectShow reports no receiver.
        const frameIntervalMs = Math.max(1, Math.floor(1000 / controller.profile.frameRate));
        scheduleMorphlyCamPublish(controller, Math.max(0, frameIntervalMs - elapsedMs));
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
  sendVirtualCameraReceiverState(false);

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
    return {
      success: true,
      message: 'Morphly cam output is already being published.',
      profile: morphlyCamPublisher.profile
    };
  }

  stopMorphlyCamPublisher();

  try {
    const publisherPath = resolveUnityCaptureSenderPath();
    const child = spawn(publisherPath, [], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });

    const controller = {
      child,
      profile: VIRTUAL_CAM_PROFILE,
      timer: null,
      writeInFlight: false,
      stopping: false,
      latestRendererFrame: null,
      lastPublishedFrame: null,
      rendererFrameSequence: 0,
      lastPublishedSequence: 0,
      frameBeingPublishedSequence: null,
      lastPublishedAt: 0,
      lastReceiverProbeAt: 0,
      receiverReady: null,
      stderrBuffer: '',
      stats: {
        startedAt: Date.now(),
        lastLogAt: Date.now(),
        framesSent: 0,
        rendererFramesReceived: 0,
        captureFallbacks: 0,
        captureFailures: 0,
        publishFailures: 0,
        rendererFramesDropped: 0,
        receiverProbes: 0,
        blackFrames: 0
      }
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      controller.stderrBuffer += chunk.toString();
      const lines = controller.stderrBuffer.split(/\r?\n/);
      controller.stderrBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line) {
          continue;
        }

        console.info(`Morphly cam publisher: ${line}`);
        if (line.includes('Waiting for an application to open Morphly Virtual Camera.')) {
          setVirtualCameraReceiverState(controller, false);
        } else if (
          line.includes('Connected to the Morphly virtual camera.')
          || line.includes('Connected to the UnityCapture virtual camera.')
        ) {
          setVirtualCameraReceiverState(controller, true);
        }
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
      const wasStopping = controller.stopping;
      controller.stopping = true;
      if (controller.timer) {
        clearTimeout(controller.timer);
        controller.timer = null;
      }

      if (morphlyCamPublisher === controller) {
        morphlyCamPublisher = null;
        sendVirtualCameraReceiverState(false);
      }

      if (!wasStopping) {
        console.error(`Virtual camera publisher exited unexpectedly with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`);
      }
    });

    morphlyCamPublisher = controller;
    scheduleMorphlyCamPublish(controller);

    console.info(
      `Morphly virtual camera profile: ${controller.profile.mode} ` +
      `${controller.profile.width}x${controller.profile.height}@${controller.profile.frameRate}.`
    );

    return {
      success: true,
      message: `Publishing Morphly cam output via ${publisherPath}.`,
      profile: controller.profile
    };
  } catch (error) {
    console.error('Unable to start the virtual camera publisher:', error);
    return { success: false, error: formatErrorMessage(error) };
  }
}

function loadEnvironmentVariables() {
  if (!isPackagedRuntime) {
    loadMorphlyEnvironment();
    return;
  }

  const envPath = path.join(process.resourcesPath, '.env');

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

function buildLoadFailureHtml(failedUrl, errorCode, errorDescription) {
  const safeUrl = String(failedUrl ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeDescription = String(errorDescription ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Morphly Startup Error</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top left, #151b2e, #05070d 60%);
        color: #f2f4ff;
        font-family: Segoe UI, Tahoma, sans-serif;
      }
      .card {
        width: min(720px, 92vw);
        border: 1px solid #2b3154;
        background: rgba(10, 14, 26, 0.9);
        border-radius: 14px;
        padding: 24px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      p {
        margin: 0 0 12px;
        color: #c6cde8;
      }
      code {
        color: #d7ddff;
        background: #11162a;
        border: 1px solid #2f3b64;
        padding: 2px 6px;
        border-radius: 6px;
      }
      ul {
        margin: 10px 0 0;
        padding-left: 20px;
        color: #d9dff9;
      }
      li { margin: 6px 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Morphly could not load the app UI</h1>
      <p>Electron started, but the renderer URL was unavailable.</p>
      <p>URL: <code>${safeUrl}</code></p>
      <p>Error: <code>${errorCode} ${safeDescription}</code></p>
      <ul>
        <li>If this is development mode, start with <code>npm run electron:dev</code> in the app folder.</li>
        <li>If another process uses port 5173 or 3000, stop it and retry.</li>
        <li>Check terminal logs for Vite or API startup failures.</li>
      </ul>
    </div>
  </body>
</html>`;
}

function logDevelopmentRendererHealth(window) {
  if (!isDevelopment) {
    return;
  }

  setTimeout(() => {
    if (window.isDestroyed()) {
      return;
    }

    void window.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root');
      return {
        readyState: document.readyState,
        rootPresent: Boolean(root),
        rootChildCount: root?.childElementCount ?? 0,
        bodyTextLength: (document.body?.innerText ?? '').trim().length
      };
    })()`).then((health) => {
      console.info(
        'Morphly renderer health: ' +
        `readyState=${health.readyState} rootPresent=${health.rootPresent} ` +
        `rootChildren=${health.rootChildCount} bodyTextLength=${health.bodyTextLength}`
      );
    }).catch((error) => {
      console.error(`Unable to inspect Morphly renderer health: ${formatErrorMessage(error)}`);
    });
  }, 1000);
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
  const iconPath = isPackagedRuntime
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../build/icon.ico');
  const windowIcon = nativeImage.createFromPath(iconPath);

  if (windowIcon.isEmpty()) {
    console.error(`Morphly window icon could not be loaded: ${iconPath}`);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: windowIcon.isEmpty() ? iconPath : windowIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  if (!windowIcon.isEmpty() && process.platform === 'win32') {
    mainWindow.setIcon(windowIcon);
  }
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:full-screen-changed', true);
    }
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:full-screen-changed', false);
    }
  });
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

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const loadFailureHtml = buildLoadFailureHtml(validatedURL, errorCode, errorDescription);
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadFailureHtml)}`);
  });

  mainWindow.webContents.once('did-finish-load', () => {
    logDevelopmentRendererHealth(mainWindow);

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
  }
}

function registerVirtualCameraHandlers() {
  ipcMain.handle('virtual-camera:start', async () => {
    const operationGeneration = ++virtualCameraOperationGeneration;
    virtualCameraEnabled = true;

    const registrationResult = await ensureVirtualCameraRegistration();
    if (operationGeneration !== virtualCameraOperationGeneration || !virtualCameraEnabled) {
      return {
        success: true,
        cancelled: true,
        message: 'Virtual camera start was cancelled.',
        profile: VIRTUAL_CAM_PROFILE
      };
    }

    if (!registrationResult.success) {
      virtualCameraEnabled = false;
      stopMorphlyCamPublisher();
      return registrationResult;
    }

    return ensureMorphlyCamPublisher();
  });

  ipcMain.handle('virtual-camera:stop', async () => {
    virtualCameraOperationGeneration += 1;
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

if (process.platform === 'win32') {
  app.setAppUserModelId('com.morphly.app');
}

function registerCameraHandlers() {
  ipcMain.handle('camera:validate-selection', async (_event, payload) => {
    return validateCameraSelectionForTrustedProcess(payload);
  });
}

function registerWindowHandlers() {
  ipcMain.handle('window:get-full-screen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return Boolean(window && !window.isDestroyed() && window.isFullScreen());
  });

  ipcMain.handle('window:toggle-full-screen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
      return false;
    }

    const nextState = !window.isFullScreen();
    window.setFullScreen(nextState);
    return nextState;
  });
}

function registerClipboardHandlers() {
  ipcMain.handle('clipboard:write-text', (_event, value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      return { success: false, error: 'Clipboard text is invalid.' };
    }

    clipboard.writeText(value);
    return { success: clipboard.readText() === value };
  });
}

function createMorphlyVcController() {
  const dataRoot = isPackagedRuntime
    ? path.join(app.getPath('userData'), 'morphlyvc')
    : path.resolve(__dirname, '../.meanvc');
  const bundledRuntimeRoot = isPackagedRuntime
    ? path.join(process.resourcesPath, 'morphlyvc', 'runtime-40ms')
    : path.join(dataRoot, 'runtime-40ms');
  const bundledBridge = isPackagedRuntime
    ? path.join(process.resourcesPath, 'morphlyvc', 'meanvc-realtime.py')
    : path.resolve(__dirname, '../server/meanvc-realtime.py');

  fs.mkdirSync(dataRoot, { recursive: true });
  return createMeanVcRuntimeController({
    repositoryRoot: path.resolve(__dirname, '../../third_party/MeanVC2'),
    dataRoot,
    bundledRuntimeRoot,
    bundledBridge,
  });
}

function registerMorphlyVcHandlers() {
  const requireMainRenderer = (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('MorphlyVC controls are available only from the Morphly dashboard.');
    }
  };
  const runtime = () => {
    if (!morphlyVcRuntime) {
      throw new Error('MorphlyVC is still starting.');
    }
    return morphlyVcRuntime;
  };

  ipcMain.handle('morphlyvc:status', (event) => {
    requireMainRenderer(event);
    return runtime().getStatus();
  });
  ipcMain.handle('morphlyvc:reference', (event, payload) => {
    requireMainRenderer(event);
    const bytes = payload?.data;
    const fileName = typeof payload?.fileName === 'string' ? payload.fileName : 'reference.wav';
    if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes) && !(bytes instanceof ArrayBuffer)) {
      throw new Error('Choose a valid WAV reference recording.');
    }
    return runtime().saveReference(Buffer.from(bytes), fileName);
  });
  ipcMain.handle('morphlyvc:prepare', (event, payload) => {
    requireMainRenderer(event);
    return runtime().prepare(payload ?? {});
  });
  ipcMain.handle('morphlyvc:start', (event, payload) => {
    requireMainRenderer(event);
    return runtime().start(payload ?? {});
  });
  ipcMain.handle('morphlyvc:pitch', (event, payload) => {
    requireMainRenderer(event);
    return runtime().setPitch(payload ?? {});
  });
  ipcMain.handle('morphlyvc:stop', (event) => {
    requireMainRenderer(event);
    return runtime().stop();
  });
  ipcMain.handle('virtual-microphone:open-setup', async (event) => {
    requireMainRenderer(event);
    await shell.openExternal('https://vb-audio.com/Cable/');
    return { success: true };
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera');
  }

  registerVirtualCameraHandlers();
  registerCameraHandlers();
  registerWindowHandlers();
  registerClipboardHandlers();
  if (isPackagedRuntime) {
    morphlyVcRuntime = createMorphlyVcController();
  }
  registerMorphlyVcHandlers();

  desktopUpdater = createDesktopUpdater({
    manifestUrl: resolveUpdateManifestUrl(),
    releasePageUrl: RELEASES_URL,
    logPath: path.join(app.getPath('userData'), 'updater.log'),
    currentVersion: app.getVersion(),
    isPackaged: isPackagedRuntime,
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
  morphlyVcRuntime?.shutdown();

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
