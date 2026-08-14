import crypto from 'crypto';
import fs from 'fs';

export function normalizeChecksum(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^sha256[:=]\s*/i, '');
}

export function normalizeExpectedSize(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function checksumMatches(expectedChecksum, hexDigest, base64Digest) {
  const expected = normalizeChecksum(expectedChecksum);
  if (!expected) return false;

  return expected.toLowerCase() === hexDigest.toLowerCase()
    || expected === base64Digest;
}

export async function hashFileSha256(filePath) {
  const hexHash = crypto.createHash('sha256');
  const base64Hash = crypto.createHash('sha256');

  for await (const chunk of fs.createReadStream(filePath)) {
    hexHash.update(chunk);
    base64Hash.update(chunk);
  }

  return {
    hexDigest: hexHash.digest('hex'),
    base64Digest: base64Hash.digest('base64')
  };
}

export async function verifyUpdateFile(filePath, options = {}) {
  const expectedChecksum = normalizeChecksum(options.checksum);
  const expectedSize = normalizeExpectedSize(options.expectedSize);

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      return { valid: false, reason: 'missing-or-empty', size: stats.size };
    }

    if (!expectedChecksum && !expectedSize) {
      return { valid: false, reason: 'missing-integrity-metadata', size: stats.size };
    }

    if (expectedSize && stats.size !== expectedSize) {
      return { valid: false, reason: 'size-mismatch', size: stats.size, expectedSize };
    }

    if (!expectedChecksum) {
      return { valid: true, reason: null, size: stats.size, checksumVerified: null };
    }

    const { hexDigest, base64Digest } = await hashFileSha256(filePath);
    if (!checksumMatches(expectedChecksum, hexDigest, base64Digest)) {
      return {
        valid: false,
        reason: 'checksum-mismatch',
        size: stats.size,
        expectedSize,
        hexDigest
      };
    }

    return {
      valid: true,
      reason: null,
      size: stats.size,
      expectedSize,
      checksumVerified: true,
      hexDigest
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { valid: false, reason: 'missing', size: 0 };
    }
    throw error;
  }
}

export function getDownloadSizeError(transferredBytes, expectedSize, responseContentLength) {
  const normalizedExpectedSize = normalizeExpectedSize(expectedSize);
  const normalizedContentLength = normalizeExpectedSize(responseContentLength);

  if (normalizedExpectedSize && normalizedContentLength && normalizedExpectedSize !== normalizedContentLength) {
    return `Update size metadata mismatch: expected ${normalizedExpectedSize} bytes but the server reported ${normalizedContentLength} bytes.`;
  }

  const requiredBytes = normalizedExpectedSize ?? normalizedContentLength;
  if (requiredBytes && transferredBytes !== requiredBytes) {
    return `Incomplete update download: received ${transferredBytes} of ${requiredBytes} bytes.`;
  }

  return null;
}
