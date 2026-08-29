import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIRTUAL_CAMERA_PROFILES,
  selectVirtualCameraProfile,
} from '../electron/virtual-camera-profile.js';

const GIB = 1024 ** 3;

test('low-CPU computers use the 360p 24fps virtual-camera profile', () => {
  assert.equal(
    selectVirtualCameraProfile({ logicalCpuCount: 4, totalMemoryBytes: 12 * GIB, override: '' }),
    VIRTUAL_CAMERA_PROFILES.low,
  );
  assert.deepEqual(VIRTUAL_CAMERA_PROFILES.low, {
    mode: 'low',
    width: 640,
    height: 360,
    frameRate: 24,
  });
});

test('midrange and high-end computers keep higher virtual-camera quality', () => {
  assert.equal(
    selectVirtualCameraProfile({ logicalCpuCount: 8, totalMemoryBytes: 16 * GIB, override: '' }),
    VIRTUAL_CAMERA_PROFILES.balanced,
  );
  assert.equal(
    selectVirtualCameraProfile({ logicalCpuCount: 12, totalMemoryBytes: 16 * GIB, override: '' }),
    VIRTUAL_CAMERA_PROFILES.high,
  );
});

test('the profile override is explicit and invalid values fall back safely', () => {
  assert.equal(
    selectVirtualCameraProfile({ logicalCpuCount: 4, totalMemoryBytes: 4 * GIB, override: 'HIGH' }),
    VIRTUAL_CAMERA_PROFILES.high,
  );
  assert.equal(
    selectVirtualCameraProfile({ logicalCpuCount: 2, totalMemoryBytes: 2 * GIB, override: 'unknown' }),
    VIRTUAL_CAMERA_PROFILES.low,
  );
});

test('the low profile cuts raw frame traffic by 80 percent versus legacy 720p30', () => {
  const legacyBytesPerSecond = 1280 * 720 * 4 * 30;
  const lowBytesPerSecond = 640 * 360 * 4 * 24;

  assert.equal(lowBytesPerSecond / legacyBytesPerSecond, 0.2);
});
