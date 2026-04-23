const fs = require('fs/promises');
const path = require('path');

const NATIVE_ARTIFACTS = [
  'morphly_cam_pipe_publisher.exe',
  'morphly_cam_registrar.exe',
  'MorphlyVirtualCamera.dll'
];

const BUILD_CONFIGS = [
  'Release',
  'RelWithDebInfo',
  'Debug'
];

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveNativeArtifacts(appDir) {
  const nativeBuildRoot = path.resolve(appDir, '..', '..', 'build');

  for (const buildConfig of BUILD_CONFIGS) {
    const candidateDirectory = path.join(nativeBuildRoot, buildConfig);
    const resolvedArtifacts = {};
    let allFound = true;

    for (const artifactName of NATIVE_ARTIFACTS) {
      const candidatePath = path.join(candidateDirectory, artifactName);
      if (!(await fileExists(candidatePath))) {
        allFound = false;
        break;
      }

      resolvedArtifacts[artifactName] = candidatePath;
    }

    if (allFound) {
      return {
        buildConfig,
        nativeBuildRoot,
        resolvedArtifacts
      };
    }
  }

  throw new Error(
    `Unable to locate native Morphly camera artifacts under ${nativeBuildRoot}. ` +
      `Build MorphlyCam first so ${NATIVE_ARTIFACTS.join(', ')} exist in Release or Debug.`
  );
}

module.exports = async function afterPack(context) {
  const appDirectory = context.packager?.info?.appDir ?? context.packager?.projectDir ?? process.cwd();
  const { buildConfig, resolvedArtifacts } = await resolveNativeArtifacts(appDirectory);
  const destinationDirectory = path.join(context.appOutDir, 'resources', 'morphly-cam');

  await fs.mkdir(destinationDirectory, { recursive: true });

  await Promise.all(
    Object.entries(resolvedArtifacts).map(([artifactName, sourcePath]) =>
      fs.copyFile(sourcePath, path.join(destinationDirectory, artifactName))
    )
  );

  console.log(
    `[afterPack] Bundled Morphly camera artifacts from ${buildConfig} into ${destinationDirectory}`
  );
};