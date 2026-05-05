const GITHUB_OWNER = 'samuellucky2424-afk';
const GITHUB_REPO = 'morphly';
const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

function normalizeText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

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
    generatedAt: new Date().toISOString(),
  };
}

function getBuildType(req) {
  const candidate = req?.query?.build ?? req?.query?.packageType ?? req?.query?.mode;
  return normalizePackageType(candidate);
}

function getGitHubToken(env = process.env) {
  const candidates = [
    env.MORPHLY_GITHUB_TOKEN,
    env.GITHUB_TOKEN,
    env.GH_TOKEN,
  ];

  for (const candidate of candidates) {
    const value = normalizeText(candidate);
    if (value) {
      return value;
    }
  }

  return null;
}

function getFallbackVersion(req, env = process.env) {
  const candidates = [
    req?.query?.currentVersion,
    env.MORPHLY_UPDATE_FALLBACK_VERSION,
    env.MORPHLY_FALLBACK_UPDATE_VERSION,
    env.APP_VERSION,
  ];

  for (const candidate of candidates) {
    const value = normalizeText(candidate);
    if (value) {
      return value;
    }
  }

  return null;
}

async function fetchLatestRelease(options = {}) {
  const token = getGitHubToken(options.env);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'morphly-updater',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(GITHUB_API_LATEST, {
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`GitHub API responded with HTTP ${response.status}`);
  }

  const data = await response.json();
  const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
  const version = tag.replace(/^v/, '').trim();

  if (!version) {
    throw new Error('GitHub API returned an empty tag_name');
  }

  const uploadedAssets = new Set(
    Array.isArray(data.assets)
      ? data.assets.map((asset) => asset.name)
      : [],
  );

  return {
    version,
    releaseNotes: data.body || null,
    uploadedAssets,
    usedToken: Boolean(token),
  };
}

export async function resolveVersionManifest(req, options = {}) {
  const env = options.env || process.env;
  const packageType = getBuildType(req);

  try {
    const { version, releaseNotes, uploadedAssets, usedToken } = await fetchLatestRelease({ env });
    const manifest = createVersionManifest({
      version,
      packageType,
      releaseNotes,
      checksum: null,
    });

    const assetName = buildAssetName(version, packageType);
    if (!uploadedAssets.has(assetName)) {
      manifest.downloadUrl = manifest.releasePageUrl;
      manifest.assetName = null;
    }

    manifest._meta = {
      fallback: false,
      usedGitHubToken: usedToken,
    };

    return manifest;
  } catch (error) {
    const fallbackVersion = getFallbackVersion(req, env);
    if (!fallbackVersion) {
      throw error;
    }

    const manifest = createVersionManifest({
      version: fallbackVersion,
      packageType,
      releaseNotes: null,
      checksum: null,
    });

    manifest.downloadUrl = GITHUB_RELEASES_URL;
    manifest.releasePageUrl = GITHUB_RELEASES_URL;
    manifest.assetName = null;
    manifest._meta = {
      fallback: true,
      reason: error instanceof Error ? error.message : String(error),
      usedGitHubToken: Boolean(getGitHubToken(env)),
    };

    return manifest;
  }
}