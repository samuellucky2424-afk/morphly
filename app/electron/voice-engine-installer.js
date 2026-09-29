import { execFile } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import path from 'path';
import { promisify } from 'util';
import { retryDownload } from '../shared/download-retry.js';

import { VOICE_ENGINE_ASSET_NAME, VOICE_ENGINE_MANIFEST_NAME, downloadVoiceEngineArchive, validateVoiceEngineManifest } from '../shared/voice-engine-archive.js';

const execFileAsync = promisify(execFile);

export const VOICE_ENGINE_DIRECTORY_NAME = 'runtime-40ms';

export function getVoiceEngineReleaseBase(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid desktop version for voice engine download.');
  return `https://github.com/samuellucky2424-afk/morphly/releases/download/v${version}`;
}

const DOWNLOAD_TIMEOUT_MS = 30000;
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_REDIRECTS = 5;

export function isVoiceEngineInstalled(installRoot) {
  if (!installRoot) return false;
  return ['python.exe', 'src/vc_pipeline_jit.py', 'models/18_asr_jit_warm.pt',
    'models/hq1W_v2_40ms_40ms_gtm_32_run4_newasr_e18_l6_asr2_en_zh_alldata/model_750000_jit.pt',
  ].every(file => fs.existsSync(path.join(installRoot, VOICE_ENGINE_DIRECTORY_NAME, file)));
}

export function getVoiceEnginePath(installRoot) {
  return path.join(installRoot, VOICE_ENGINE_DIRECTORY_NAME);
}

function quoteForPowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function request(url, options = {}) {
  const opts = typeof options === 'number' ? { redirectsRemaining: options } : (options || {});
  const {
    startByte = 0,
    headers = {},
    redirectsRemaining = MAX_REDIRECTS,
    timeout = DOWNLOAD_TIMEOUT_MS,
  } = opts;

  const requestHeaders = { ...headers };
  if (startByte > 0) {
    requestHeaders['Range'] = `bytes=${startByte}-`;
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    const request_ = https.get(url, { headers: requestHeaders, timeout }, (response) => {
      const { statusCode, headers: resHeaders } = response;

      if (statusCode >= 300 && statusCode < 400 && resHeaders.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(Object.assign(new Error('The voice engine download redirected too many times.'), { retryable: false }));
          return;
        }
        const nextUrl = new URL(resHeaders.location, url).toString();
        request(nextUrl, { ...opts, redirectsRemaining: redirectsRemaining - 1 })
          .then(resolve, reject);
        return;
      }

      if (statusCode !== 200 && statusCode !== 206) {
        response.resume();
        reject(Object.assign(new Error(`The voice engine download failed (HTTP ${statusCode}).`), { statusCode }));
        return;
      }

      resolved = true;
      response.statusCode = statusCode;
      response.isPartial = statusCode === 206;
      response.startByte = response.isPartial ? startByte : 0;

      // Socket inactivity handles stalls without a data listener: a data
      // listener here would start flowing before the file pipeline is attached.
      response.setTimeout(timeout, () => {
        response.destroy(new Error('The voice engine download timed out.'));
      });

      resolve(response);
    });

    request_.on('timeout', () => {
      request_.destroy(new Error('The voice engine download timed out.'));
    });
    request_.on('error', (err) => {
      if (!resolved) reject(err);
    });
  });
}

async function fetchManifest(baseUrl) {
  const response = await request(`${baseUrl}/${VOICE_ENGINE_MANIFEST_NAME}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 64 * 1024) {
      response.destroy();
      throw Object.assign(new Error('The voice engine download manifest is too large.'), { retryable: false });
    }
    chunks.push(chunk);
  }
  try {
    return validateVoiceEngineManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    error.retryable = false;
    throw error;
  }
}

async function extractZip(zipPath, destinationDirectory) {
  // Expand-Archive ships with Windows PowerShell, so no extra unpacker binary
  // has to be bundled. The staging directory is kept short to stay well under
  // the legacy 260-character path limit.
  const command = [
    '$ErrorActionPreference = "Stop";',
    `Expand-Archive -LiteralPath ${quoteForPowerShell(zipPath)}`,
    `-DestinationPath ${quoteForPowerShell(destinationDirectory)} -Force`,
  ].join(' ');

  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { windowsHide: true, timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
}

export async function installVoiceEngine({ installRoot, tempRoot, version, onProgress = () => {} }) {
  if (!installRoot || !tempRoot) throw new Error('A voice engine install location is required.');
  const baseUrl = getVoiceEngineReleaseBase(version);
  const targetRoot = getVoiceEnginePath(installRoot);
  if (isVoiceEngineInstalled(installRoot)) return { installPath: targetRoot };

  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.mkdir(tempRoot, { recursive: true });
  // Deterministic download directory per version so partial downloads persist across restarts/retries
  const downloadDirectory = path.join(tempRoot, `download-${version}`);
  await fsp.mkdir(downloadDirectory, { recursive: true });
  let stagingDirectory;
  try {
    // Stage on the destination volume so activation uses an atomic rename even
    // when Windows TEMP and application data are on different drives.
    stagingDirectory = await fsp.mkdtemp(path.join(installRoot, '.install-'));
    const zipPath = path.join(downloadDirectory, VOICE_ENGINE_ASSET_NAME);
    const manifestPath = path.join(downloadDirectory, VOICE_ENGINE_MANIFEST_NAME);
    const savedBytes = (await fsp.stat(zipPath).catch(() => ({ size: 0 }))).size;
    let savedManifest;
    try { savedManifest = validateVoiceEngineManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf8'))); } catch { /* Fetch a fresh manifest below. */ }
    const savedProgress = {
      phase: 'downloading',
      percent: savedManifest ? Math.min(99, Math.floor(savedBytes / savedManifest.size * 100)) : 0,
      receivedBytes: savedBytes,
      totalBytes: savedManifest?.size,
      resumed: savedBytes > 0,
    };
    onProgress(savedProgress);
    const manifest = await retryDownload(() => fetchManifest(baseUrl), {
      onRetry: (retry) => onProgress({ ...savedProgress, ...retry }),
    });
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));
    await downloadVoiceEngineArchive({
      manifest,
      baseUrl,
      destinationPath: zipPath,
      requestStream: request,
      onProgress,
      maxRetries: Infinity, // Temporary network failures never discard progress or exhaust retries.
      initialRetryDelayMs: 2000,
      maxRetryDelayMs: 15000,
      cleanOnFailure: false, // Keep partial download for resume!
    });
    onProgress({ phase: 'extracting', percent: 100 });
    await extractZip(zipPath, stagingDirectory);

    const extractedRoot = path.join(stagingDirectory, VOICE_ENGINE_DIRECTORY_NAME);
    if (!isVoiceEngineInstalled(stagingDirectory)) {
      throw new Error('The voice engine archive was incomplete. Please try again.');
    }
    // Preserve any incomplete previous installation until activation succeeds.
    const backupRoot = path.join(stagingDirectory, 'previous-runtime');
    const hadPrevious = fs.existsSync(targetRoot);
    if (hadPrevious) await fsp.rename(targetRoot, backupRoot);
    try {
      await fsp.rename(extractedRoot, targetRoot);
    } catch (error) {
      if (hadPrevious) {
        try {
          await fsp.rename(backupRoot, targetRoot);
        } catch {
          // Keep the recovery copy if Windows is holding a file open.
          stagingDirectory = null;
        }
      }
      throw error;
    }
    // Remove download cache after successful extraction to free disk space
    await fsp.rm(downloadDirectory, { recursive: true, force: true }).catch(() => {});
    onProgress({ phase: 'done', percent: 100 });
    return { installPath: targetRoot };
  } finally {
    if (stagingDirectory) await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    // Note: downloadDirectory is deliberately preserved on incomplete download so next attempt resumes
  }
}
