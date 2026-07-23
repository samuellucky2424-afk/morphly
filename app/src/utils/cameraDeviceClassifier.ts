export const VIRTUAL_CAMERA_KEYWORDS = [
  'virtual',
  'morphly',
  'avatar mimic',
  'obs',
  'manycam',
  'snap camera',
  'xsplit',
  'vcam',
  'nvidia broadcast',
  'droidcam',
  'epoccam',
  'unity capture',
  'unity video capture',
  'vmix',
  'webcammax',
  'splitcam',
  'vb-cable',
  'cable output',
] as const;

const PHYSICAL_CAMERA_KEYWORDS = [
  'camera',
  'webcam',
  'integrated',
  'built-in',
  'facetime',
  'internal',
  'usb',
  'logitech',
  'lenovo',
  'dell',
  'hp ',
] as const;

export function normalizeCameraLabel(label: string): string {
  return String(label || '').trim().toLowerCase();
}

export function isVirtualCamera(label: string): boolean {
  const normalizedLabel = normalizeCameraLabel(label);
  return VIRTUAL_CAMERA_KEYWORDS.some((keyword) => normalizedLabel.includes(keyword));
}

export function isLikelyPhysicalCamera(label: string): boolean {
  const normalizedLabel = normalizeCameraLabel(label);
  if (!normalizedLabel || isVirtualCamera(normalizedLabel)) return false;

  // Known hardware terms provide a strong signal. Unknown non-empty labels are
  // still allowed because manufacturers use many localized/model-specific names;
  // exact-device probing and a second post-open label check provide the other
  // defensive layers.
  return PHYSICAL_CAMERA_KEYWORDS.some((keyword) => normalizedLabel.includes(keyword))
    || normalizedLabel.length > 0;
}

export function getAllowedPhysicalCameras(
  devices: MediaDeviceInfo[],
): MediaDeviceInfo[] {
  const seenDeviceIds = new Set<string>();

  return devices.filter((device) => {
    if (
      device.kind !== 'videoinput'
      || !device.deviceId
      || seenDeviceIds.has(device.deviceId)
      || !isLikelyPhysicalCamera(device.label)
    ) {
      return false;
    }

    seenDeviceIds.add(device.deviceId);
    return true;
  });
}

export function getBlockedVirtualCameras(
  devices: MediaDeviceInfo[],
): MediaDeviceInfo[] {
  return devices.filter((device) =>
    device.kind === 'videoinput' && isVirtualCamera(device.label));
}

export function subscribeToCameraDeviceChanges(
  mediaDevices: MediaDevices,
  listener: () => void,
): () => void {
  mediaDevices.addEventListener('devicechange', listener);
  return () => mediaDevices.removeEventListener('devicechange', listener);
}
