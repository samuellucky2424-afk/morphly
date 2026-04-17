// @ts-nocheck
import { createVersionManifest, normalizePackageType, resolveChecksum, resolveReleaseNotes } from '../../shared/update-manifest.ts';

// IMPORTANT: Keep this in sync with app/package.json "version" field.
// On Vercel serverless, fs.readFileSync cannot reach ../package.json at runtime.
const LATEST_VERSION = '1.1.3';

function getBuildType(req) {
  const candidate = req?.query?.build ?? req?.query?.packageType ?? req?.query?.mode;
  return normalizePackageType(candidate);
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const packageType = getBuildType(req);
    const manifest = createVersionManifest({
      version: LATEST_VERSION,
      packageType,
      releaseNotes: resolveReleaseNotes(),
      checksum: resolveChecksum(packageType)
    });

    return res.status(200).json(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
