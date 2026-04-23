export type DesktopUpdatePackageType = 'installer' | 'portable';
export type DesktopUpdateInstallMode = 'auto-install' | 'download-only';
export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface DesktopUpdateProgress {
  percent: number;
  transferredBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  packageType: DesktopUpdatePackageType | null;
  installMode: DesktopUpdateInstallMode;
  manifestUrl: string | null;
  releasePageUrl: string | null;
  sourceLabel: string | null;
  sourceHost: string | null;
  downloadUrl: string | null;
  checksum: string | null;
  releaseNotes: string | null;
  assetName: string | null;
  downloadedFileName: string | null;
  downloadedPath: string | null;
  downloadDirectory: string | null;
  downloadProgress: DesktopUpdateProgress;
  progress: number;
  updateAvailable: boolean;
  readyToInstall: boolean;
  canAutoInstall: boolean;
  checksumVerified: boolean | null;
  checkInProgress: boolean;
  downloadInProgress: boolean;
  installInProgress: boolean;
  error: string | null;
  lastCheckedAt: string | null;
  lastDownloadedAt: string | null;
  lastInstalledAt: string | null;
}

export interface DesktopUpdateActionResult extends Partial<DesktopUpdateState> {
  success: boolean;
  error?: string;
  inProgress?: boolean;
  installing?: boolean;
  updateAvailable?: boolean;
  downloadStarted?: boolean;
  readyToInstall?: boolean;
  downloadOnly?: boolean;
  revealed?: boolean;
  launched?: boolean;
  downloadedPath?: string | null;
  downloadedFileName?: string | null;
}

const DEFAULT_PROGRESS: DesktopUpdateProgress = {
  percent: 0,
  transferredBytes: 0,
  totalBytes: null,
  bytesPerSecond: null,
  etaSeconds: null
};

export const DEFAULT_DESKTOP_UPDATE_STATE: DesktopUpdateState = {
  status: 'idle',
  currentVersion: 'Unknown',
  latestVersion: null,
  packageType: null,
  installMode: 'download-only',
  manifestUrl: null,
  releasePageUrl: null,
  sourceLabel: null,
  sourceHost: null,
  downloadUrl: null,
  checksum: null,
  releaseNotes: null,
  assetName: null,
  downloadedFileName: null,
  downloadedPath: null,
  downloadDirectory: null,
  downloadProgress: DEFAULT_PROGRESS,
  progress: 0,
  updateAvailable: false,
  readyToInstall: false,
  canAutoInstall: false,
  checksumVerified: null,
  checkInProgress: false,
  downloadInProgress: false,
  installInProgress: false,
  error: null,
  lastCheckedAt: null,
  lastDownloadedAt: null,
  lastInstalledAt: null
};

function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electron?.invoke);
}

function normalizeProgress(progress: Partial<DesktopUpdateProgress> | null | undefined): DesktopUpdateProgress {
  return {
    ...DEFAULT_PROGRESS,
    ...(progress ?? {})
  };
}

export function normalizeDesktopUpdateState(state?: Partial<DesktopUpdateState> | null): DesktopUpdateState {
  const merged = {
    ...DEFAULT_DESKTOP_UPDATE_STATE,
    ...(state ?? {})
  };

  return {
    ...merged,
    downloadProgress: normalizeProgress(merged.downloadProgress)
  };
}

async function invokeDesktopUpdate<T>(channel: string, fallback: T, ...args: unknown[]): Promise<T> {
  if (!hasDesktopBridge()) {
    return fallback;
  }

  try {
    const result = await window.electron!.invoke(channel, ...args);
    return result as T;
  } catch {
    return fallback;
  }
}

export function isDesktopUpdaterAvailable(): boolean {
  return hasDesktopBridge();
}

export async function getDesktopUpdateState(): Promise<DesktopUpdateState> {
  const state = await invokeDesktopUpdate<Partial<DesktopUpdateState> | null>('get-update-state', null);
  return normalizeDesktopUpdateState(state);
}

export function subscribeToDesktopUpdateState(
  listener: (state: DesktopUpdateState) => void
): () => void {
  if (!hasDesktopBridge()) {
    return () => {};
  }

  return window.electron!.on('desktop-updater:state', (state: Partial<DesktopUpdateState>) => {
    listener(normalizeDesktopUpdateState(state));
  });
}

export async function checkForUpdates(): Promise<DesktopUpdateActionResult> {
  return invokeDesktopUpdate<DesktopUpdateActionResult>(
    'check-for-updates',
    { success: false, error: 'Desktop updates are only available in the Electron app.' }
  );
}

export async function downloadUpdate(): Promise<DesktopUpdateActionResult> {
  return invokeDesktopUpdate<DesktopUpdateActionResult>(
    'download-update',
    { success: false, error: 'Desktop updates are only available in the Electron app.' }
  );
}

export async function installUpdate(): Promise<DesktopUpdateActionResult> {
  return invokeDesktopUpdate<DesktopUpdateActionResult>(
    'install-update',
    { success: false, error: 'Desktop updates are only available in the Electron app.' }
  );
}

export async function openReleasePage(): Promise<DesktopUpdateActionResult> {
  return invokeDesktopUpdate<DesktopUpdateActionResult>(
    'open-release-page',
    { success: false, error: 'Desktop updates are only available in the Electron app.' }
  );
}

export function formatUpdateProgress(progress: DesktopUpdateProgress): string {
  if (progress.totalBytes && progress.totalBytes > 0) {
    return `${progress.percent.toFixed(0)}%`;
  }

  return progress.percent > 0 ? `${progress.percent.toFixed(0)}%` : '0%';
}

export function formatUpdatePackageType(packageType: DesktopUpdatePackageType | null): string {
  if (packageType === 'portable') return 'Portable';
  if (packageType === 'installer') return 'Installer';
  return 'Unknown';
}

export function formatUpdateInstallMode(installMode: DesktopUpdateInstallMode): string {
  return installMode === 'auto-install' ? 'Auto-install on Windows' : 'Download only';
}

