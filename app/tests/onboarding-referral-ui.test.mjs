import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shouldAutoStartOnboarding,
} from '../src/components/onboarding/onboardingState.ts';
import {
  getReferralCodeFormatError,
  normalizeReferralCode,
} from '../src/utils/referralCode.ts';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(currentDirectory, '..');

test('first-time user sees onboarding automatically', () => {
  assert.equal(shouldAutoStartOnboarding({
    completed: false,
    version: 1,
    currentVersion: 1,
  }), true);
});

test('returning user does not see onboarding automatically', () => {
  assert.equal(shouldAutoStartOnboarding({
    completed: true,
    version: 1,
    currentVersion: 1,
  }), false);
});

test('future version does not rerun unless intentionally reset', () => {
  assert.equal(shouldAutoStartOnboarding({
    completed: true,
    version: 1,
    currentVersion: 2,
  }), false);
});

test('referral code is optional, normalized and format checked', () => {
  assert.equal(getReferralCodeFormatError(''), null);
  assert.equal(normalizeReferralCode('  mly7k4p2  '), 'MLY7K4P2');
  assert.equal(getReferralCodeFormatError('MLY7K4P2'), null);
  assert.match(getReferralCodeFormatError('bad-code'), /6 to 12/i);
});

test('dashboard contains all seven stable tour targets and exact guide text', () => {
  const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
  const steps = fs.readFileSync(
    path.join(appDirectory, 'src/components/onboarding/dashboardTourSteps.tsx'),
    'utf8',
  );
  const tour = fs.readFileSync(
    path.join(appDirectory, 'src/components/onboarding/MorphlyDashboardTour.tsx'),
    'utf8',
  );
  const targets = [
    'dashboard',
    'camera-selector',
    'upload-image',
    'start-stream',
    'stop-stream',
    'buy-credits',
    'settings',
  ];
  for (const target of targets) {
    assert.match(dashboard, new RegExp(`data-tour="${target}"`));
    assert.match(steps, new RegExp(`data-tour=.?"${target}"`));
  }
  assert.match(steps, /Welcome to Morphly/);
  assert.match(tour, /Start using Morphly/);
  assert.match(tour, /EVENTS\.TARGET_NOT_FOUND/);
  assert.match(tour, /targetWaitTimeout: 1500/);
  assert.match(tour, /calc\(100vw-32px\)/);
});

test('Settings can restart only the guided-tour state', () => {
  const settings = fs.readFileSync(path.join(appDirectory, 'src/pages/Settings.tsx'), 'utf8');
  assert.match(settings, /updateOnboardingState\('restart'\)/);
  assert.match(settings, /Credits, camera settings and purchases are untouched/);
});

test('referral code and link use the trusted Electron clipboard with a browser fallback', () => {
  const settings = fs.readFileSync(path.join(appDirectory, 'src/pages/Settings.tsx'), 'utf8');
  const mainProcess = fs.readFileSync(path.join(appDirectory, 'electron/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(appDirectory, 'electron/preload.js'), 'utf8');

  assert.match(settings, /clipboard:write-text/);
  assert.match(settings, /navigator\.clipboard\?\.writeText/);
  assert.match(mainProcess, /clipboard\.writeText\(value\)/);
  assert.match(preload, /clipboard:write-text/);
});

test('tour skip and finish states are persisted explicitly', () => {
  const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
  const tour = fs.readFileSync(
    path.join(appDirectory, 'src/components/onboarding/MorphlyDashboardTour.tsx'),
    'utf8',
  );
  assert.match(dashboard, /updateOnboardingState\('complete'\)/);
  assert.match(dashboard, /updateOnboardingState\('skip'\)/);
  assert.match(tour, /Skip the setup guide\? You can restart it later from Settings\./);
});

test('start helper text covers missing image, credits, engine and updater state', () => {
  const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
  assert.match(dashboard, /Upload a reference image before starting\./);
  assert.match(dashboard, /You do not have enough credits\. Buy credits to continue\./);
  assert.match(dashboard, /The Morphly engine is not ready yet\./);
  assert.match(dashboard, /Wait for the application update process to finish\./);
});

test('dashboard has native full-screen controls and no countdown card', () => {
  const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
  const mainProcess = fs.readFileSync(path.join(appDirectory, 'electron/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(appDirectory, 'electron/preload.js'), 'utf8');

  assert.match(dashboard, /window:toggle-full-screen/);
  assert.match(dashboard, /Exit Full Screen/);
  assert.match(mainProcess, /window\.setFullScreen\(nextState\)/);
  assert.match(preload, /window:full-screen-changed/);
  assert.doesNotMatch(dashboard, />Remaining</);
  assert.doesNotMatch(dashboard, /formatTime\(getRemainingSeconds\(\)\)/);
});

test('Windows runtime and installer use the Morphly application icon', () => {
  const mainProcess = fs.readFileSync(path.join(appDirectory, 'electron/main.js'), 'utf8');
  const devLauncher = fs.readFileSync(
    path.join(appDirectory, 'scripts/launch-branded-electron-dev.cjs'),
    'utf8',
  );
  const packageConfig = JSON.parse(
    fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'),
  );

  assert.match(mainProcess, /nativeImage\.createFromPath\(iconPath\)/);
  assert.match(mainProcess, /mainWindow\.setIcon\(windowIcon\)/);
  assert.match(devLauncher, /MorphlyDesktopDev\.exe/);
  assert.match(devLauncher, /'--set-icon'/);
  assert.match(packageConfig.scripts['electron:dev:wait'], /launch-branded-electron-dev\.cjs/);
  assert.equal(packageConfig.build.win.icon, 'build/icon.ico');
  assert.equal(packageConfig.build.win.signAndEditExecutable, true);
  assert.equal(packageConfig.build.nsis.shortcutName, 'Morphly Desktop');
});
