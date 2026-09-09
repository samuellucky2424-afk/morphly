import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { VOICE_ENGINE_ASSET_NAME, VOICE_ENGINE_PART_BYTES, validateVoiceEngineManifest } from '../shared/voice-engine-archive.js';

export async function splitVoiceEngine(archivePath, partBytes = VOICE_ENGINE_PART_BYTES) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > VOICE_ENGINE_PART_BYTES) {
    throw new Error('Invalid voice engine part size.');
  }
  const source = await fs.open(archivePath, 'r');
  const archiveHash = createHash('sha256');
  const manifest = { format: 1, archive: VOICE_ENGINE_ASSET_NAME, size: 0, sha256: '', parts: [] };
  const buffer = Buffer.alloc(Math.min(1024 * 1024, partBytes));
  try {
    const { size } = await source.stat();
    if (!size) throw new Error('Cannot package an empty voice engine archive.');
    while (manifest.size < size) {
      const name = `${VOICE_ENGINE_ASSET_NAME}.part-${String(manifest.parts.length + 1).padStart(3, '0')}`;
      const output = await fs.open(path.join(path.dirname(archivePath), name), 'w');
      const hash = createHash('sha256');
      let written = 0;
      try {
        while (written < partBytes && manifest.size < size) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, partBytes - written), null);
          if (!bytesRead) throw new Error('Voice engine archive ended unexpectedly.');
          const chunk = buffer.subarray(0, bytesRead);
          await output.writeFile(chunk);
          hash.update(chunk);
          archiveHash.update(chunk);
          written += bytesRead;
          manifest.size += bytesRead;
        }
      } finally {
        await output.close();
      }
      manifest.parts.push({ name, size: written, sha256: hash.digest('hex') });
    }
  } finally {
    await source.close();
  }
  manifest.sha256 = archiveHash.digest('hex');
  validateVoiceEngineManifest(manifest);
  await fs.writeFile(`${archivePath}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = await splitVoiceEngine(path.resolve(process.argv[2]));
  console.log(`Packaged ${manifest.size} bytes into ${manifest.parts.length} verified voice engine parts.`);
}
