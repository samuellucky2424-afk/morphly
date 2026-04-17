// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createVersionManifest, normalizePackageType, resolveChecksum, resolveReleaseNotes } from '../../shared/update-manifest.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.join(__dirname, '../package.json');

function readVersionFromPackageJson() {
  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(raw);
  if (!packageJson?.version) {
    throw new Error('Missing version in app/package.json');
  }
  return String(packageJson.version);
}

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
    const latestVersion = readVersionFromPackageJson();
    const packageType = getBuildType(req);
    const manifest = createVersionManifest({
      version: latestVersion,
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

