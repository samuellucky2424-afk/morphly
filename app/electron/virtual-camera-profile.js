import os from 'os';

const GIB = 1024 ** 3;

export const VIRTUAL_CAMERA_PROFILES = Object.freeze({
  low: Object.freeze({ mode: 'low', width: 640, height: 360, frameRate: 24 }),
  balanced: Object.freeze({ mode: 'balanced', width: 960, height: 540, frameRate: 24 }),
  high: Object.freeze({ mode: 'high', width: 1280, height: 720, frameRate: 30 })
});

export function selectVirtualCameraProfile({
  logicalCpuCount = os.cpus()?.length ?? 8,
  totalMemoryBytes = os.totalmem(),
  override = process.env.MORPHLY_VIRTUAL_CAMERA_PROFILE
} = {}) {
  const requestedMode = String(override ?? '').trim().toLowerCase();
  if (Object.hasOwn(VIRTUAL_CAMERA_PROFILES, requestedMode)) {
    return VIRTUAL_CAMERA_PROFILES[requestedMode];
  }

  if (logicalCpuCount <= 4 || totalMemoryBytes <= 4 * GIB) {
    return VIRTUAL_CAMERA_PROFILES.low;
  }

  if (logicalCpuCount <= 8 || totalMemoryBytes <= 8 * GIB) {
    return VIRTUAL_CAMERA_PROFILES.balanced;
  }

  return VIRTUAL_CAMERA_PROFILES.high;
}
