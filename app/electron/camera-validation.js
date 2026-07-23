const VIRTUAL_CAMERA_KEYWORDS = [
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
];

export function isTrustedProcessVirtualCamera(label) {
  const normalized = String(label || '').trim().toLowerCase();
  return VIRTUAL_CAMERA_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export function validateCameraSelectionForTrustedProcess(payload) {
  const selectedDeviceId = String(payload?.selectedDeviceId || '').trim();
  const selectedLabel = String(payload?.selectedLabel || '').trim();
  const availableDevices = Array.isArray(payload?.availableDevices) ? payload.availableDevices : [];

  if (!selectedDeviceId) {
    return { valid: false, error: 'Select your physical laptop camera first.' };
  }

  const matchingDevice = availableDevices.find((device) =>
    String(device?.deviceId || '').trim() === selectedDeviceId);
  if (!matchingDevice) {
    return {
      valid: false,
      error: 'The selected camera is no longer available. Please select another physical camera.',
    };
  }

  const trustedLabel = String(matchingDevice.label || selectedLabel || '').trim();
  if (!trustedLabel) {
    return { valid: false, error: 'Allow camera permission before starting Morphly.' };
  }

  if (isTrustedProcessVirtualCamera(trustedLabel)) {
    return {
      valid: false,
      error: 'Virtual cameras cannot be used as the Morphly input. Select your integrated or USB hardware camera.',
    };
  }

  return { valid: true, deviceId: selectedDeviceId, label: trustedLabel };
}
