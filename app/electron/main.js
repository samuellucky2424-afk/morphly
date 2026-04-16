import { app, BrowserWindow, systemPreferences, ipcMain, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDevelopment = !app.isPackaged && process.env.NODE_ENV !== 'production';
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';
let mainWindow = null;

// Explicitly load the .env file as requested
const envPath = app.isPackaged 
    ? path.join(process.resourcesPath, '.env') 
    : path.join(__dirname, '../.env');

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

// Enable hardware acceleration BEFORE app ready (must be before any window creation)
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-software-rasterizer');

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

  // Completely remove the default white menu bar
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  if (isDevelopment) {
    void mainWindow.loadURL(rendererDevUrl);
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

app.whenReady().then(async () => {
  // Request camera access inherently for WebRTC dependencies
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera');
  }
  
  // Virtual Camera IPC Handlers
  ipcMain.handle('virtual-camera:start', async () => {
    // In a full implementation, this would trigger the OBS Virtual Camera SDK
    // or a native add-on. For now, we return success to allow the renderer
    // to proceed with its canvas-based stream which acts as the source.
    console.log('Virtual Camera start requested');
    return { success: true, message: 'Virtual Camera stream initialized' };
  });

  ipcMain.handle('virtual-camera:stop', async () => {
    console.log('Virtual Camera stop requested');
    return { success: true };
  });

  // Update handlers
  ipcMain.handle('check-for-updates', async () => {
    console.log('Update check requested...');
    try {
      // If we're in development, auto-updater won't work normally without a dev-app-update.yml
      // However, we can still try to check and return the error if it fails.
      const result = await autoUpdater.checkForUpdates();
      
      if (!result) {
        console.log('Update check returned no result');
        return { success: false, error: 'No response from update server' };
      }

      console.log('Update check result:', result.updateInfo.version);
      
      const currentVersion = app.getVersion();
      const latestVersion = result.updateInfo.version;

      if (latestVersion > currentVersion) {
        console.log(`Update available: ${latestVersion} (Current: ${currentVersion})`);
        // We don't download immediately here to give user control, 
        // but the SDK might start it automatically depending on config.
        return { 
          success: true, 
          updateAvailable: true, 
          version: latestVersion,
          currentVersion: currentVersion
        };
      }
      
      console.log('No updates available');
      return { success: true, updateAvailable: false, currentVersion };
    } catch (error) {
      console.error('Update check error details:', error);
      return { 
        success: false, 
        error: error.message || 'Unknown update error',
        details: error.stack
      };
    }
  });

  ipcMain.handle('download-update', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('install-update', async () => {
    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  createWindow();

  // Auto-updater event listeners
  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.updateInfo.version);
  });

  autoUpdater.on('error', (err) => {
    console.error('Update error:', err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
