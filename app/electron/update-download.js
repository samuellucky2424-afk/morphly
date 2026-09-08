import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeChecksum, normalizeExpectedSize, verifyUpdateFile } from './update-integrity.js';

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const fatal = (message) => Object.assign(new Error(message), { retryable: false });
const strongEtag = (value) => value && /^"[^"\r\n]+"$/.test(value) ? value : null;

async function readMetadata(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function fileSize(file) {
  try { return (await fs.stat(file)).size; } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

/** A bounded-memory download that survives network loss and app restarts.
 * Only the fully verified file is promoted to the installable destination.
 * The timeout measures inactivity, never the total time on a slow connection.
 */
export async function downloadUpdateFile({
  url, destination, checksum, expectedSize, onProgress = () => {}, onRetry = () => {},
  signal, fetchImpl = fetch, idleTimeoutMs = 90_000, maxAttempts = 4,
  retryDelayMs = 1_000, checkDiskSpace = true,
}) {
  const partial = `${destination}.part`;
  const metadataFile = `${partial}.json`;
  const expectedChecksum = normalizeChecksum(checksum);
  const publishedSize = normalizeExpectedSize(expectedSize);
  const identity = JSON.stringify([url, expectedChecksum, publishedSize]);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let metadata = await readMetadata(metadataFile);
  let offset = await fileSize(partial);
  let total = publishedSize;

  async function discardPartial() {
    // Explicit updater-owned files only; no recursive cache deletion.
    await fs.rm(partial, { force: true });
    await fs.rm(metadataFile, { force: true });
    metadata = null;
    offset = 0;
  }

  if (!metadata || metadata.identity !== identity || (!expectedChecksum && !strongEtag(metadata.etag))) {
    await discardPartial();
  } else {
    total ??= normalizeExpectedSize(metadata.total);
    if (total && offset > total) await discardPartial();
  }

  async function finish() {
    const integrity = await verifyUpdateFile(partial, { checksum: expectedChecksum, expectedSize: total });
    if (!integrity.valid) {
      await discardPartial();
      throw fatal(`Update verification failed (${integrity.reason}). Retry to download a fresh copy.`);
    }
    await fs.rename(partial, destination);
    await fs.rm(metadataFile, { force: true }).catch(() => {});
    return integrity;
  }

  if (total && offset === total) return finish();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timer;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('Download connection stopped responding.')), idleTimeoutMs);
    };
    const cancel = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    let reader;
    let file;
    let failure;
    let completed = false;
    const startedAt = Date.now();
    let receivedThisAttempt = 0;
    try {
      armTimeout();
      const headers = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };
      if (offset > 0) {
        headers.Range = `bytes=${offset}-`;
        if (strongEtag(metadata?.etag)) headers['If-Range'] = metadata.etag;
      }
      const response = await fetchImpl(url, { headers, cache: 'no-store', signal: controller.signal });
      reader = response.body?.getReader();
      if (response.status === 416 && offset) {
        await discardPartial();
        throw new Error('The saved download no longer matches the server. Restarting safely.');
      }
      if (!response.ok || !reader) {
        const error = new Error(`Update download returned HTTP ${response.status}.`);
        error.retryable = TRANSIENT_STATUS.has(response.status);
        throw error;
      }
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') throw fatal('Update server returned an encoded installer; byte ranges cannot be verified.');
      const contentLength = normalizeExpectedSize(response.headers.get('content-length'));
      const etag = strongEtag(response.headers.get('etag'));
      let responseBytes = contentLength;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        const [start, end, size] = range ? range.slice(1).map(Number) : [];
        if (!range || ![start, end, size].every(Number.isSafeInteger) || start !== offset || end < start || end >= size
          || (total && size !== total) || (contentLength && contentLength !== end - start + 1)) {
          await discardPartial();
          throw fatal('Update server returned an invalid download range. Retry for a fresh copy.');
        }
        if (offset && !expectedChecksum && (!etag || etag !== metadata?.etag)) {
          await discardPartial();
          throw fatal('The update changed during download. Retry for a fresh copy.');
        }
        total = size;
        responseBytes = end - start + 1;
      } else if (response.status === 200) {
        // If-Range mismatch or a server without Range support: replace, never append.
        offset = 0;
        if (publishedSize && contentLength && publishedSize !== contentLength) {
          await discardPartial();
          throw fatal('Update size metadata does not match the server. Check for updates again.');
        }
        total = publishedSize ?? contentLength;
      } else {
        throw fatal(`Unexpected update response: HTTP ${response.status}.`);
      }
      if (!expectedChecksum && !total) throw fatal('Update server did not provide integrity metadata.');
      if (checkDiskSpace && total) {
        const disk = await fs.statfs(path.dirname(destination));
        if (disk.bavail * disk.bsize < total - offset + 64 * 1024 * 1024) {
          throw fatal('Not enough free disk space for this update. Free some space and retry; saved progress is kept.');
        }
      }
      file = await fs.open(partial, offset ? 'r+' : 'w');
      metadata = { identity, etag, total };
      await fs.writeFile(metadataFile, JSON.stringify(metadata));
      while (true) {
        controller.signal.throwIfAborted();
        armTimeout();
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        if ((total && offset + value.byteLength > total)
          || (responseBytes && receivedThisAttempt + value.byteLength > responseBytes)) {
          throw fatal('Update server sent more data than the published installer size.');
        }
        let written = 0;
        while (written < value.byteLength) {
          const result = await file.write(value, written, value.byteLength - written, offset);
          if (!result.bytesWritten) throw fatal('Unable to save the update download.');
          written += result.bytesWritten;
          offset += result.bytesWritten;
        }
        receivedThisAttempt += value.byteLength;
        const bytesPerSecond = receivedThisAttempt / Math.max(.001, (Date.now() - startedAt) / 1000);
        onProgress({ transferredBytes: offset, totalBytes: total,
          percent: total ? Math.min(100, offset / total * 100) : 0, bytesPerSecond,
          etaSeconds: total ? Math.max(0, (total - offset) / bytesPerSecond) : null });
      }
      if ((responseBytes && receivedThisAttempt !== responseBytes) || (total && offset !== total)) {
        throw new Error('The connection ended before the download was complete.');
      }
      await file.sync();
      completed = true;
    } catch (error) {
      failure = signal?.aborted ? signal.reason : (controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // Close the writer on EVERY exit before a retry, verification or cleanup.
      await reader?.cancel().catch(() => {});
      await file?.close();
    }
    if (completed) return finish();
    if (signal?.aborted) throw failure;
    if (['ENOSPC', 'EACCES', 'EPERM'].includes(failure?.code) || failure?.retryable === false) throw failure;
    // Without a digest or strong validator it is unsafe to combine two responses.
    if (!expectedChecksum && !strongEtag(metadata?.etag)) await discardPartial();
    if (attempt === maxAttempts) {
      throw new Error(`Download interrupted. ${offset ? 'Your progress is saved; retry to continue.' : 'Please retry when your connection is stable.'}`, { cause: failure });
    }
    onRetry({ attempt, transferredBytes: offset });
    await delay(retryDelayMs * attempt, undefined, { signal });
  }
}
