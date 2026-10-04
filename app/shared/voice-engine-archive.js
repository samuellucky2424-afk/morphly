import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isRetryableDownloadError } from './download-retry.js';

export const VOICE_ENGINE_ASSET_NAME = 'morphlyvc-runtime-40ms.zip';
export const VOICE_ENGINE_MANIFEST_NAME = `${VOICE_ENGINE_ASSET_NAME}.json`;
export const VOICE_ENGINE_PART_BYTES = 1024 ** 3;

export function validateVoiceEngineManifest(manifest) {
  const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (manifest?.format !== 1 || manifest.archive !== VOICE_ENGINE_ASSET_NAME
    || !validHash(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size <= 0
    || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 64) {
    throw new Error('Invalid voice engine download manifest.');
  }
  let total = 0;
  manifest.parts.forEach((part, index) => {
    if (part?.name !== `${VOICE_ENGINE_ASSET_NAME}.part-${String(index + 1).padStart(3, '0')}`
      || !Number.isSafeInteger(part.size) || part.size <= 0 || part.size > VOICE_ENGINE_PART_BYTES
      || !validHash(part.sha256)) {
      throw new Error('Invalid voice engine download part.');
    }
    total += part.size;
  });
  if (total !== manifest.size) throw new Error('Voice engine download size does not match its parts.');
  return manifest;
}

async function streamSliceToHash(filePath, start, end, hash, onBytes = () => {}) {
  if (start >= end) return 0;
  const stream = fs.createReadStream(filePath, { start, end: end - 1, highWaterMark: 1024 * 1024 });
  let bytesRead = 0;
  for await (const chunk of stream) {
    for (const item of Array.isArray(hash) ? hash : [hash]) item.update(chunk);
    bytesRead += chunk.length;
    onBytes(bytesRead);
  }
  return bytesRead;
}

async function statDownload(filePath) {
  try { return await fs.promises.stat(filePath); }
  catch (error) {
    if (error.code === 'ENOENT') return { size: 0 };
    throw error;
  }
}

// Stream directly into one ZIP, keeping memory bounded and avoiding a second
// multi-gigabyte copy of the parts. Supports resuming partial downloads and
// automatic retries on network interruptions. Checksums are mandatory for every part.
export async function downloadVoiceEngineArchive({
  manifest,
  baseUrl,
  destinationPath,
  requestStream,
  onProgress = () => {},
  maxRetries = 0,
  initialRetryDelayMs = 2000,
  maxRetryDelayMs = 20000,
  cleanOnFailure = true,
}) {
  validateVoiceEngineManifest(manifest);

  let cumulative = 0;
  const partRanges = manifest.parts.map((part) => {
    const start = cumulative;
    const end = cumulative + part.size;
    cumulative = end;
    return { ...part, start, end };
  });

  let currentSize = (await statDownload(destinationPath)).size;
  if (currentSize > manifest.size) {
    await fs.promises.truncate(destinationPath, 0);
    currentSize = 0;
  }

  // Keep the saved byte count, but give local verification its own progress.
  onProgress({ phase: currentSize ? 'verifying' : 'downloading', percent: 0, receivedBytes: currentSize, totalBytes: manifest.size, resumed: currentSize > 0 });

  let archiveHash = createHash('sha256');
  let verifiedBytes = 0;
  let lastReportedPercent = -1;

  // Scan existing parts on disk to verify fully downloaded ones
  for (const part of partRanges) {
    if (currentSize >= part.end) {
      const partCheckHash = createHash('sha256');
      const candidateHash = archiveHash.copy();
      await streamSliceToHash(destinationPath, part.start, part.end, [partCheckHash, candidateHash], bytes => {
        const percent = Math.floor((part.start + bytes) / manifest.size * 100);
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;
          onProgress({ phase: 'verifying', percent, receivedBytes: currentSize, totalBytes: manifest.size, resumed: true });
        }
      });
      if (partCheckHash.digest('hex') === part.sha256) {
        archiveHash = candidateHash;
        verifiedBytes = part.end;
        const percent = Math.min(99, Math.floor(currentSize / manifest.size * 100));
        lastReportedPercent = percent;
        continue;
      }
      // Checksum mismatch for this completed part; truncate back to start of part
      await fs.promises.truncate(destinationPath, part.start);
      currentSize = part.start;
      break;
    } else {
      break;
    }
  }

  try {
    for (const part of partRanges) {
      if (verifiedBytes >= part.end) {
        continue;
      }

      let attempt = 0;
      let integrityFailures = 0;
      while (true) {
        try {
          const statNow = await statDownload(destinationPath);
          let cur = statNow.size;
          if (cur < part.start || cur > part.end) {
            cur = part.start;
            await fs.promises.truncate(destinationPath, cur);
          }

          let startInPart = cur - part.start;
          let currentPartHash = createHash('sha256');
          if (startInPart > 0) {
            await streamSliceToHash(destinationPath, part.start, cur, currentPartHash);
            const totalSoFar = part.start + startInPart;
            const percent = Math.min(99, Math.floor(totalSoFar / manifest.size * 100));
            onProgress({
              phase: 'downloading',
              percent,
              receivedBytes: totalSoFar,
              totalBytes: manifest.size,
              resumed: true,
            });
          }

          // A socket may close after the last byte is written but before the
          // pipeline finishes. Verify that part instead of requesting bytes=size-.
          if (startInPart === part.size) {
            if (currentPartHash.digest('hex') === part.sha256) {
              await streamSliceToHash(destinationPath, part.start, part.end, archiveHash);
              verifiedBytes = part.end;
              break;
            }
            await fs.promises.truncate(destinationPath, part.start);
            throw Object.assign(new Error('The downloaded voice engine part is corrupt.'), { integrity: true });
          }

          const response = await requestStream(`${baseUrl}/${part.name}`, {
            startByte: startInPart,
            headers: startInPart > 0 ? { Range: `bytes=${startInPart}-` } : {},
          });

          if (response?.statusCode === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers?.['content-range'] || '');
            if (!range || Number(range[1]) !== startInPart || Number(range[2]) !== part.size - 1 || Number(range[3]) !== part.size) {
              response.destroy();
              throw Object.assign(new Error('The download server returned an invalid byte range.'), { retryable: false });
            }
          }

          // If the server answered 200 instead of 206 for a Range request, it sent full content from 0
          if (startInPart > 0 && response?.statusCode === 200) {
            await fs.promises.truncate(destinationPath, part.start);
            cur = part.start;
            startInPart = 0;
            currentPartHash = createHash('sha256');
          }

          let partBytesReceived = 0;
          const verify = new Transform({
            transform(chunk, encoding, callback) {
              partBytesReceived += chunk.length;
              if (startInPart + partBytesReceived > part.size) {
                callback(Object.assign(new Error('Voice engine download exceeded its expected size.'), { retryable: false }));
                return;
              }
              currentPartHash.update(chunk);
              const currentTotal = part.start + startInPart + partBytesReceived;
              const percent = Math.min(99, Math.floor(currentTotal / manifest.size * 100));
              if (percent !== lastReportedPercent) {
                lastReportedPercent = percent;
                onProgress({ phase: 'downloading', percent, receivedBytes: currentTotal, totalBytes: manifest.size });
              }
              callback(null, chunk);
            },
          });

          const writeStream = fs.createWriteStream(destinationPath, {
            flags: cur === 0 ? 'w' : 'a',
          });

          await pipeline(response, verify, writeStream);

          const totalPartBytes = startInPart + partBytesReceived;
          if (totalPartBytes !== part.size) {
            // A cleanly closed but short response is resumable too.
            throw new Error('The voice engine download was interrupted.');
          }
          if (currentPartHash.digest('hex') !== part.sha256) {
            // Integrity check failed: truncate back to start of part
            await fs.promises.truncate(destinationPath, part.start);
            throw Object.assign(new Error('The voice engine download failed its integrity check. Please try again.'), { integrity: true });
          }

          // Feed verified part into archiveHash
          await streamSliceToHash(destinationPath, part.start, part.end, archiveHash);
          verifiedBytes = part.end;
          break; // Part finished successfully!
        } catch (error) {
          attempt++;
          if (error.integrity) integrityFailures++;
          if (attempt > maxRetries || !isRetryableDownloadError(error) || integrityFailures >= 3) {
            throw error;
          }
          const delay = Math.min(maxRetryDelayMs, Math.round(initialRetryDelayMs * Math.pow(1.5, attempt - 1)));
          const statAfter = await statDownload(destinationPath);
          onProgress({
            phase: 'downloading',
            percent: Math.min(99, Math.floor(statAfter.size / manifest.size * 100)),
            receivedBytes: statAfter.size,
            totalBytes: manifest.size,
            retrying: true,
            retryAttempt: attempt,
            retryDelayMs: delay,
            error: error.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    onProgress({ phase: 'verifying', percent: 100 });
    if (archiveHash.digest('hex') !== manifest.sha256) {
      throw new Error('The voice engine archive failed its integrity check. Please try again.');
    }
  } catch (error) {
    if (cleanOnFailure) {
      await fs.promises.rm(destinationPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}
