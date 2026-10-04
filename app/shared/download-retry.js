import { setTimeout as delay } from 'node:timers/promises';

export function isRetryableDownloadError(error) {
  if (error?.retryable === false) return false;
  if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'AbortError'].includes(error?.code || error?.name)) return false;
  if (error?.statusCode) return [408, 425, 429].includes(error.statusCode) || error.statusCode >= 500;
  return true;
}

export async function retryDownload(operation, {
  maxRetries = Infinity,
  initialRetryDelayMs = 2000,
  maxRetryDelayMs = 15000,
  onRetry = () => {},
  wait = delay,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= maxRetries || !isRetryableDownloadError(error)) throw error;
      const retryDelayMs = Math.min(maxRetryDelayMs, initialRetryDelayMs * 1.5 ** Math.min(attempt, 30));
      await onRetry({ retrying: true, retryAttempt: attempt + 1, retryDelayMs, error: error.message });
      await wait(retryDelayMs);
    }
  }
}
