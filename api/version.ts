// @ts-nocheck

/**
 * IMPORTANT: Keep LATEST_VERSION in sync with app/package.json "version" field.
 * This file is fully self-contained - no external imports that could fail on Vercel serverless.
 */
const LATEST_VERSION = '1.1.4';

const GITHUB_OWNER = 'samuellucky2424-afk';
const GITHUB_REPO = 'morphly';
const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

function normalizePackageType(value) {
  return value === 'portable' ? 'portable' : 'installer';
}

function buildAssetName(version, packageType) {
  const safeVersion = version.trim();
  return packageType === 'portable'
    ? `Morphly-${safeVersion}.exe`
    : `Morphly-Setup-${safeVersion}.exe`;
}

function buildReleasePageUrl(version) {
  return `${GITHUB_REPOSITORY_URL}/releases/tag/v${version.trim()}`;
}

function buildDownloadUrl(version, packageType) {
  const assetName = buildAssetName(version, packageType);
  return `${GITHUB_REPOSITORY_URL}/releases/download/v${version.trim()}/${encodeURIComponent(assetName)}`;
}

function createVersionManifest(options) {
  const version = options.version.trim();
  const packageType = options.packageType || 'installer';
  const assetName = buildAssetName(version, packageType);

  return {
    latestVersion: version,
    downloadUrl: buildDownloadUrl(version, packageType),
    packageType,
    checksum: options.checksum || null,
    releaseNotes: options.releaseNotes || null,
    releasePageUrl: buildReleasePageUrl(version),
    sourceLabel: 'GitHub Releases',
    assetName,
    generatedAt: new Date().toISOString()
  };
}

function getBuildType(req) {
  const candidate = req?.query?.build ?? req?.query?.packageType ?? req?.query?.mode;
  return normalizePackageType(candidate);
}

export default async function handler(req, res) {
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
      releaseNotes: null,
      checksum: null
    });

    return res.status(200).json(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
