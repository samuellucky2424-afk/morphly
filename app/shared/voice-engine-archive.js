import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

// Stream directly into one ZIP, keeping memory bounded and avoiding a second
// multi-gigabyte copy of the parts. Checksums are mandatory for every part.
export async function downloadVoiceEngineArchive({ manifest, baseUrl, destinationPath, requestStream, onProgress = () => {} }) {
  validateVoiceEngineManifest(manifest);
  let receivedBytes = 0;
  let lastPercent = -1;
  const archiveHash = createHash('sha256');
  try {
    for (const [index, part] of manifest.parts.entries()) {
      const response = await requestStream(`${baseUrl}/${part.name}`);
      let partBytes = 0;
      const partHash = createHash('sha256');
      const verify = new Transform({
        transform(chunk, encoding, callback) {
          partBytes += chunk.length;
          if (partBytes > part.size) {
            callback(new Error('Voice engine download exceeded its expected size.'));
            return;
          }
          partHash.update(chunk);
          archiveHash.update(chunk);
          receivedBytes += chunk.length;
          const percent = Math.min(99, Math.floor(receivedBytes / manifest.size * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress({ phase: 'downloading', percent, receivedBytes, totalBytes: manifest.size });
          }
          callback(null, chunk);
        },
      });
      await pipeline(response, verify, fs.createWriteStream(destinationPath, { flags: index === 0 ? 'w' : 'a' }));
      if (partBytes !== part.size || partHash.digest('hex') !== part.sha256) {
        throw new Error('The voice engine download failed its integrity check. Please try again.');
      }
    }
    onProgress({ phase: 'verifying', percent: 100 });
    if (archiveHash.digest('hex') !== manifest.sha256) {
      throw new Error('The voice engine archive failed its integrity check. Please try again.');
    }
  } catch (error) {
    await fs.promises.rm(destinationPath, { force: true }).catch(() => {});
    throw error;
  }
}
