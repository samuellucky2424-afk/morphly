import {
  getAllowedPhysicalCameras,
  getBlockedVirtualCameras,
  isVirtualCamera,
} from './cameraDeviceClassifier';

export interface CameraEnumerationResult {
  allVideoInputs: MediaDeviceInfo[];
  physicalCameras: MediaDeviceInfo[];
  virtualCameras: MediaDeviceInfo[];
  permission: PermissionState | 'unsupported' | 'unknown';
}

async function queryCameraPermission(): Promise<PermissionState | 'unsupported' | 'unknown'> {
  if (!navigator.permissions?.query) return 'unsupported';

  try {
    const result = await navigator.permissions.query({
      name: 'camera' as PermissionName,
    });
    return result.state;
  } catch {
    return 'unknown';
  }
}

export async function enumeratePhysicalCameras(
  options?: { requestPermission?: boolean },
): Promise<CameraEnumerationResult> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('Camera access is not supported on this device.');
  }

  let devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((device) => device.kind === 'videoinput');
  const labelsUnavailable = videoInputs.some((device) => !device.label);

  if (options?.requestPermission && labelsUnavailable) {
    const permissionStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    permissionStream.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }

  const allVideoInputs = devices.filter((device) => device.kind === 'videoinput');
  return {
    allVideoInputs,
    physicalCameras: getAllowedPhysicalCameras(allVideoInputs),
    virtualCameras: getBlockedVirtualCameras(allVideoInputs),
    permission: await queryCameraPermission(),
  };
}

export function validateSelectedPhysicalCamera(
  selectedCameraId: string,
  devices: MediaDeviceInfo[],
): MediaDeviceInfo {
  if (!selectedCameraId) {
    throw new Error('Select your physical laptop camera first.');
  }

  const selectedDevice = devices.find((device) =>
    device.kind === 'videoinput' && device.deviceId === selectedCameraId);
  if (!selectedDevice) {
    throw new Error('The selected camera is no longer available. Please select another physical camera.');
  }

  if (isVirtualCamera(selectedDevice.label)) {
    throw new Error('Virtual cameras cannot be used as the Morphly input. Select your integrated or USB hardware camera.');
  }

  if (!selectedDevice.label) {
    throw new Error('Allow camera permission before starting Morphly.');
  }

  return selectedDevice;
}

export function validateOpenedCameraTrack(
  track: MediaStreamTrack,
  selectedCameraId: string,
): void {
  const settings = track.getSettings();
  if (settings.deviceId && settings.deviceId !== selectedCameraId) {
    throw new Error('Morphly could not open the exact camera you selected.');
  }

  if (isVirtualCamera(track.label)) {
    throw new Error('Virtual cameras cannot be used as the Morphly input. Select your integrated or USB hardware camera.');
  }
}
