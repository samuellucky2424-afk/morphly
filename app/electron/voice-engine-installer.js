import { execFile } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import path from 'path';
import { promisify } from 'util';

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
  return fs.existsSync(path.join(installRoot, VOICE_ENGINE_DIRECTORY_NAME, 'python.exe'));
}

export function getVoiceEnginePath(installRoot) {
  return path.join(installRoot, VOICE_ENGINE_DIRECTORY_NAME);
}

function quoteForPowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function request(url, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const request_ = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
      const { statusCode, headers } = response;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error('The voice engine download redirected too many times.'));
          return;
        }
        request(new URL(headers.location, url).toString(), redirectsRemaining - 1)
          .then(resolve, reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`The voice engine download failed (HTTP ${statusCode}).`));
        return;
      }

      resolve(response);
    });

    request_.on('timeout', () => {
      request_.destroy(new Error('The voice engine download timed out.'));
    });
    request_.on('error', reject);
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
      throw new Error('The voice engine download manifest is too large.');
    }
    chunks.push(chunk);
  }
  return validateVoiceEngineManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
  const downloadDirectory = await fsp.mkdtemp(path.join(tempRoot, 'download-'));
  let stagingDirectory;
  try {
    // Stage on the destination volume so activation uses an atomic rename even
    // when Windows TEMP and application data are on different drives.
    stagingDirectory = await fsp.mkdtemp(path.join(installRoot, '.install-'));
    const zipPath = path.join(downloadDirectory, VOICE_ENGINE_ASSET_NAME);
    onProgress({ phase: 'downloading', percent: 0 });
    const manifest = await fetchManifest(baseUrl);
    await downloadVoiceEngineArchive({ manifest, baseUrl, destinationPath: zipPath, requestStream: request, onProgress });
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
    onProgress({ phase: 'done', percent: 100 });
    return { installPath: targetRoot };
  } finally {
    if (stagingDirectory) await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(downloadDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
