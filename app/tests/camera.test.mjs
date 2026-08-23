import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAllowedPhysicalCameras,
  isLikelyPhysicalCamera,
  isVirtualCamera,
  subscribeToCameraDeviceChanges,
} from '../src/utils/cameraDeviceClassifier.ts';
import {
  QUALITY_MODE_PROFILES,
  buildVideoInputConstraints,
} from '../src/lib/realtime-quality.ts';
import {
  validateCameraSelectionForTrustedProcess,
} from '../electron/camera-validation.js';

function camera(deviceId, label) {
  return { deviceId, label, kind: 'videoinput', groupId: 'hardware-group' };
}

test('accepts HP Integrated Camera', () => {
  assert.equal(isLikelyPhysicalCamera('HP Integrated Camera'), true);
});

test('accepts Integrated Webcam', () => {
  assert.equal(isLikelyPhysicalCamera('Integrated Webcam'), true);
});

test('accepts a USB hardware webcam', () => {
  assert.equal(isLikelyPhysicalCamera('Logitech USB Webcam'), true);
});

test('rejects known Morphly, Avatar Mimic and OBS virtual cameras', () => {
  assert.equal(isVirtualCamera('Morphly Virtual Camera'), true);
  assert.equal(isVirtualCamera('Avatar Mimic Real Time Windows Virtual Camera'), true);
  assert.equal(isVirtualCamera('OBS Virtual Camera'), true);
});

test('allowed camera list excludes virtual inputs', () => {
  const devices = [
    camera('hp', 'HP Integrated Camera'),
    camera('morphly', 'Morphly Virtual Camera'),
    camera('usb', 'USB Camera'),
  ];
  assert.deepEqual(
    getAllowedPhysicalCameras(devices).map((device) => device.deviceId),
    ['hp', 'usb'],
  );
});

test('trusted process blocks no selection, missing selection and virtual selection', () => {
  const availableDevices = [
    camera('hp', 'HP Integrated Camera'),
    camera('virtual', 'Morphly Virtual Camera'),
  ];
  assert.equal(validateCameraSelectionForTrustedProcess({ availableDevices }).valid, false);
  assert.match(
    validateCameraSelectionForTrustedProcess({
      selectedDeviceId: 'missing',
      availableDevices,
    }).error,
    /no longer available/i,
  );
  assert.equal(validateCameraSelectionForTrustedProcess({
    selectedDeviceId: 'virtual',
    selectedLabel: 'Morphly Virtual Camera',
    availableDevices,
  }).valid, false);
});

test('trusted process accepts the selected physical camera', () => {
  const selected = camera('hp', 'HP Integrated Camera');
  assert.deepEqual(
    validateCameraSelectionForTrustedProcess({
      selectedDeviceId: selected.deviceId,
      selectedLabel: selected.label,
      availableDevices: [selected],
    }),
    { valid: true, deviceId: 'hp', label: 'HP Integrated Camera' },
  );
});

test('camera constraints always use the exact selected deviceId', () => {
  const constraints = buildVideoInputConstraints('hd', 'physical-device-id');
  assert.deepEqual(constraints.video.deviceId, { exact: 'physical-device-id' });
  assert.equal(constraints.audio, false);
});

test('HD camera input matches Lucy 2.5 native 720p dimensions and frame rate', () => {
  assert.deepEqual(QUALITY_MODE_PROFILES.hd, {
    label: 'HD 720p',
    width: 1280,
    height: 720,
    targetFps: 30,
    maxFps: 30,
  });
});

test('devicechange subscription refreshes and cleans up', () => {
  let subscribed;
  let removed;
  const mediaDevices = {
    addEventListener(event, listener) {
      assert.equal(event, 'devicechange');
      subscribed = listener;
    },
    removeEventListener(event, listener) {
      assert.equal(event, 'devicechange');
      removed = listener;
    },
  };
  let refreshes = 0;
  const unsubscribe = subscribeToCameraDeviceChanges(mediaDevices, () => {
    refreshes += 1;
  });
  subscribed();
  unsubscribe();
  assert.equal(refreshes, 1);
  assert.equal(removed, subscribed);
});
