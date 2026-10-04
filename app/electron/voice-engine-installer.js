import { execFile } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import path from 'path';
import { createInterface } from 'node:readline';
import { retryDownload } from '../shared/download-retry.js';

import { VOICE_ENGINE_ASSET_NAME, VOICE_ENGINE_MANIFEST_NAME, downloadVoiceEngineArchive, validateVoiceEngineManifest } from '../shared/voice-engine-archive.js';

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

async function selectDownloadDirectory(tempRoot, version) {
  const candidates = [];
  for (const entry of await fsp.readdir(tempRoot, { withFileTypes: true })) {
    const match = /^download-(\d+\.\d+\.\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const directory = path.join(tempRoot, entry.name);
    try {
      const manifest = validateVoiceEngineManifest(JSON.parse(await fsp.readFile(path.join(directory, VOICE_ENGINE_MANIFEST_NAME), 'utf8')));
      const { size } = await fsp.stat(path.join(directory, VOICE_ENGINE_ASSET_NAME));
      if (size > 0 && size <= manifest.size) candidates.push({ directory, version: match[1], progress: size / manifest.size });
    } catch { /* An incomplete manifest is recovered by the normal download path. */ }
  }
  // The runtime is shared across desktop releases, just as an already installed
  // engine is reused after an app update. Retain the saved release's manifest
  // and URL, and verify all bytes against it before unpacking.
  candidates.sort((a, b) => b.progress - a.progress || Number(b.version === version) - Number(a.version === version));
  return candidates[0] || { directory: path.join(tempRoot, `download-${version}`), version };
}

export async function extractZip(zipPath, destinationDirectory, onProgress = () => {}) {
  const script = await fsp.readFile(new URL('./extract-voice-engine.ps1', import.meta.url), 'utf8');
  const command = `$archivePath = ${quoteForPowerShell(zipPath)}; $stagingPath = ${quoteForPowerShell(destinationDirectory)};\n${script}`;
  await new Promise((resolve, reject) => {
    const child = execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      error => error ? reject(error) : resolve());
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const match = /^EXTRACT (\d+)$/.exec(line);
      if (match) onProgress({ phase: 'extracting', percent: Math.min(100, Number(match[1])) });
    });
    child.once('close', () => lines.close());
  });
}

export async function installVoiceEngine({ installRoot, tempRoot, version, onProgress = () => {} }, {
  fetchManifestImpl = fetchManifest, extractZipImpl = extractZip, requestStream = request,
} = {}) {
  if (!installRoot || !tempRoot) throw new Error('A voice engine install location is required.');
  getVoiceEngineReleaseBase(version); // Validate before constructing paths.
  const targetRoot = getVoiceEnginePath(installRoot);
  if (isVoiceEngineInstalled(installRoot)) return { installPath: targetRoot };

  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.mkdir(tempRoot, { recursive: true });
  const savedDownload = await selectDownloadDirectory(tempRoot, version);
  const baseUrl = getVoiceEngineReleaseBase(savedDownload.version);
  const downloadDirectory = savedDownload.directory;
  await fsp.mkdir(downloadDirectory, { recursive: true });
  let stagingDirectory;
  let activated = false;
  try {
    const zipPath = path.join(downloadDirectory, VOICE_ENGINE_ASSET_NAME);
    const manifestPath = path.join(downloadDirectory, VOICE_ENGINE_MANIFEST_NAME);
    const savedBytes = (await fsp.stat(zipPath).catch(() => ({ size: 0 }))).size;
    let savedManifest;
    try { savedManifest = validateVoiceEngineManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf8'))); } catch { /* Fetch a fresh manifest below. */ }
    const savedProgress = {
      phase: savedManifest && savedBytes > 0 ? 'verifying' : 'downloading',
      percent: 0,
      receivedBytes: savedBytes,
      totalBytes: savedManifest?.size,
      resumed: savedBytes > 0,
    };
    onProgress(savedProgress);
    // Releases are immutable. A saved, validated manifest allows completed
    // downloads to be installed after reopening even without a connection.
    const manifest = savedManifest || await retryDownload(() => fetchManifestImpl(baseUrl), {
      onRetry: (retry) => onProgress({ ...savedProgress, ...retry }),
    });
    if (!savedManifest) {
      await fsp.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest));
      await fsp.rename(`${manifestPath}.tmp`, manifestPath);
    }
    await downloadVoiceEngineArchive({
      manifest,
      baseUrl,
      destinationPath: zipPath,
      requestStream,
      onProgress,
      maxRetries: Infinity, // Temporary network failures never discard progress or exhaust retries.
      initialRetryDelayMs: 2000,
      maxRetryDelayMs: 15000,
      cleanOnFailure: false, // Keep partial download for resume!
    });
    // Stable, archive-specific staging retains finished files across restarts.
    // It is on the destination volume so activation remains an atomic rename.
    stagingDirectory = path.join(installRoot, `.install-${manifest.sha256.slice(0, 16)}`);
    await fsp.mkdir(stagingDirectory, { recursive: true });
    onProgress({ phase: 'extracting', percent: 0 });
    await extractZipImpl(zipPath, stagingDirectory, onProgress);

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
      activated = true;
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
    if (activated && stagingDirectory) await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    // Both the ZIP and completed extracted files survive a failed/closed setup.
  }
}
