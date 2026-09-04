const fs = require('fs/promises');
const path = require('path');

const UNITY_CAPTURE_FILTERS = [
  'UnityCaptureFilter32.dll',
  'UnityCaptureFilter64.dll'
];
const SENDER_EXE = 'morphly_unity_capture_sender.exe';
const MEDIA_FOUNDATION_CAMERA_ARTIFACTS = [
  'MorphlyVirtualCameraMF.dll',
  'morphly_cam_registrar.exe'
];
const BUILD_CONFIGS = ['Release', 'RelWithDebInfo', 'Debug'];

function getSenderBuildRoots(appDir) {
  const roots = [];

  if (process.env.MORPHLY_UNITY_CAPTURE_BUILD_DIR) {
    roots.push(path.resolve(appDir, process.env.MORPHLY_UNITY_CAPTURE_BUILD_DIR));
  }

  roots.push(path.resolve(appDir, '..', 'unity-capture-bridge', 'build'));
  return [...new Set(roots)];
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSender(appDir) {
  const buildRoots = getSenderBuildRoots(appDir);

  for (const buildRoot of buildRoots) {
    const candidateDirectories = [
      buildRoot,
      ...BUILD_CONFIGS.map((config) => path.join(buildRoot, config))
    ];

    for (const candidateDirectory of candidateDirectories) {
      const candidate = path.join(candidateDirectory, SENDER_EXE);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    `Unable to locate ${SENDER_EXE}. Run "npm run virtual-camera:build" before packaging.`
  );
}

async function resolveMediaFoundationCameraArtifacts(appDir) {
  const buildRoots = getSenderBuildRoots(appDir);
  const artifacts = {};

  for (const artifactName of MEDIA_FOUNDATION_CAMERA_ARTIFACTS) {
    let resolved = null;
    for (const buildRoot of buildRoots) {
      const candidateDirectories = [
        path.join(buildRoot, 'native-camera'),
        ...BUILD_CONFIGS.map((config) => path.join(buildRoot, 'native-camera', config)),
        buildRoot,
        ...BUILD_CONFIGS.map((config) => path.join(buildRoot, config))
      ];

      for (const candidateDirectory of candidateDirectories) {
        const candidate = path.join(candidateDirectory, artifactName);
        if (await fileExists(candidate)) {
          resolved = candidate;
          break;
        }
      }

      if (resolved) break;
    }

    if (!resolved) {
      throw new Error(
        `Unable to locate ${artifactName}. Run "npm run virtual-camera:build" before packaging.`
      );
    }
    artifacts[artifactName] = resolved;
  }

  return artifacts;
}

async function resolveUnityCaptureArtifacts(appDir) {
  const upstreamInstallDirectory = path.resolve(
    appDir,
    '..',
    'third_party',
    'UnityCapture',
    'Install'
  );
  const noticePath = path.resolve(appDir, 'build', 'UNITY_CAPTURE_NOTICE.txt');
  const senderPath = await resolveSender(appDir);
  const artifacts = {
    [SENDER_EXE]: senderPath,
    'THIRD_PARTY_NOTICES.txt': noticePath
  };

  for (const filterName of UNITY_CAPTURE_FILTERS) {
    const filterPath = path.join(upstreamInstallDirectory, filterName);
    if (!(await fileExists(filterPath))) {
      throw new Error(
        `Unable to locate ${filterName}. Run "git submodule update --init --recursive" first.`
      );
    }
    artifacts[filterName] = filterPath;
  }

  return artifacts;
}

module.exports = async function afterPack(context) {
  const appDirectory = context.packager?.info?.appDir ?? context.packager?.projectDir ?? process.cwd();
  const artifacts = await resolveUnityCaptureArtifacts(appDirectory);
  const mediaFoundationArtifacts = await resolveMediaFoundationCameraArtifacts(appDirectory);
  const destinationDirectory = path.join(context.appOutDir, 'resources', 'unity-capture');
  const mediaFoundationDestinationDirectory = path.join(
    context.appOutDir,
    'resources',
    'media-foundation-camera'
  );

  await fs.mkdir(destinationDirectory, { recursive: true });
  await fs.mkdir(mediaFoundationDestinationDirectory, { recursive: true });
  await Promise.all([
    ...Object.entries(artifacts).map(([artifactName, sourcePath]) =>
      fs.copyFile(sourcePath, path.join(destinationDirectory, artifactName))
    ),
    ...Object.entries(mediaFoundationArtifacts).map(([artifactName, sourcePath]) =>
      fs.copyFile(sourcePath, path.join(mediaFoundationDestinationDirectory, artifactName))
    )
  ]);

  console.log(
    `[afterPack] Bundled UnityCapture into ${destinationDirectory} and ` +
    `the Media Foundation camera into ${mediaFoundationDestinationDirectory}`
  );
};
