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

let mainWindow = null;
let desktopUpdater = null;

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
    console.log('Virtual Camera start requested');
    return { success: true, message: 'Virtual Camera stream initialized' };
  });

  ipcMain.handle('virtual-camera:stop', async () => {
    console.log('Virtual Camera stop requested');
    return { success: true };
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

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-software-rasterizer');

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
