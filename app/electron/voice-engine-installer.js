import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// The MorphlyVC runtime (embedded Python + models) is ~2.8 GB, so it is no
// longer bundled in the installer. It ships as a separate release asset that
// users download on demand from the Voice Changer panel.
export const VOICE_ENGINE_ASSET_NAME = 'morphlyvc-runtime-40ms.zip';
export const VOICE_ENGINE_DIRECTORY_NAME = 'runtime-40ms';
const RELEASE_DOWNLOAD_BASE = 'https://github.com/samuellucky2424-afk/morphly/releases/latest/download';
export const VOICE_ENGINE_DOWNLOAD_URL = `${RELEASE_DOWNLOAD_BASE}/${VOICE_ENGINE_ASSET_NAME}`;
export const VOICE_ENGINE_CHECKSUM_URL = `${RELEASE_DOWNLOAD_BASE}/${VOICE_ENGINE_ASSET_NAME}.sha256`;

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

async function fetchExpectedChecksum() {
  try {
    const response = await request(VOICE_ENGINE_CHECKSUM_URL);
    const body = await new Promise((resolve, reject) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
        if (data.length > 512) response.destroy();
      });
      response.on('end', () => resolve(data));
      response.on('error', reject);
    });
    const match = /[a-f0-9]{64}/i.exec(body);
    return match ? match[0].toLowerCase() : null;
  } catch {
    // A missing checksum file must not block installation.
    return null;
  }
}

async function sha256OfFile(filePath) {
  const hash = createHash('sha256');
  const handle = await fsp.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }

  return hash.digest('hex');
}

async function downloadToFile(url, destinationPath, onProgress) {
  const response = await request(url);
  const totalBytes = Number(response.headers['content-length'] || 0);
  let receivedBytes = 0;
  let lastReportedPercent = -1;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destinationPath);
    fileStream.on('error', reject);

    response.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (totalBytes > 0) {
        const percent = Math.min(99, Math.floor((receivedBytes / totalBytes) * 100));
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;
          onProgress(percent, receivedBytes, totalBytes);
        }
      }
    });
    response.on('error', reject);
    response.on('end', () => {
      fileStream.end(() => resolve());
    });

    fileStream.on('finish', () => resolve());
    response.pipe(fileStream);
  });

  return { receivedBytes, totalBytes };
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

export async function installVoiceEngine({ installRoot, tempRoot, onProgress = () => {} }) {
  if (!installRoot || !tempRoot) {
    throw new Error('A voice engine install location is required.');
  }

  const targetRoot = getVoiceEnginePath(installRoot);
  const stagingDirectory = path.join(tempRoot, `morphly-voice-engine-${Date.now()}`);
  const zipPath = path.join(tempRoot, VOICE_ENGINE_ASSET_NAME);

  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.mkdir(stagingDirectory, { recursive: true });

  try {
    onProgress({ phase: 'downloading', percent: 0 });
    const expectedChecksum = await fetchExpectedChecksum();

    const { receivedBytes, totalBytes } = await downloadToFile(
      VOICE_ENGINE_DOWNLOAD_URL,
      zipPath,
      (percent, received, total) => {
        onProgress({ phase: 'downloading', percent, receivedBytes: received, totalBytes: total });
      },
    );

    if (receivedBytes === 0) {
      throw new Error('The voice engine download was empty. Check the connection and try again.');
    }

    if (expectedChecksum) {
      onProgress({ phase: 'verifying', percent: 100 });
      const actualChecksum = await sha256OfFile(zipPath);
      if (actualChecksum !== expectedChecksum) {
        throw new Error('The voice engine download failed its integrity check. Please try again.');
      }
    }

    onProgress({ phase: 'extracting', percent: 100 });
    await extractZip(zipPath, stagingDirectory);

    const extractedRoot = path.join(stagingDirectory, VOICE_ENGINE_DIRECTORY_NAME);
    if (!fs.existsSync(path.join(extractedRoot, 'python.exe'))) {
      throw new Error('The voice engine archive was incomplete. Please try again.');
    }

    await fsp.rm(targetRoot, { recursive: true, force: true });
    await fsp.rename(extractedRoot, targetRoot);

    onProgress({ phase: 'done', percent: 100 });
    return { installPath: targetRoot };
  } finally {
    await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(zipPath, { force: true }).catch(() => {});
  }
}
