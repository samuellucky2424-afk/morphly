import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDirectory = path.resolve(appDirectory, '..');
const meanVcDirectory = path.join(workspaceDirectory, 'third_party', 'MeanVC2');
const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
const dashboardStyles = fs.readFileSync(path.join(appDirectory, 'src/pages/dashboard.css'), 'utf8');
const panel = fs.readFileSync(path.join(appDirectory, 'src/components/MeanVcPanel.tsx'), 'utf8');
const server = fs.readFileSync(path.join(appDirectory, 'server.js'), 'utf8');
const runtimeController = fs.readFileSync(path.join(appDirectory, 'server/meanvc-runtime.js'), 'utf8');
const electronMain = fs.readFileSync(path.join(appDirectory, 'electron/main.js'), 'utf8');
const electronPreload = fs.readFileSync(path.join(appDirectory, 'electron/preload.js'), 'utf8');
const packageConfig = JSON.parse(fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'));
const realtimeBridge = path.join(appDirectory, 'server/meanvc-realtime.py');
const bridge = fs.readFileSync(realtimeBridge, 'utf8');

test('MeanVC2 is vendored as a real runnable upstream repository', () => {
  assert.equal(fs.existsSync(path.join(meanVcDirectory, '.git')), true);
  assert.equal(fs.existsSync(path.join(meanVcDirectory, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(meanVcDirectory, 'runtime/run_rt.py')), true);
});

test('the dashboard keeps MeanVC2 and the live streaming preview in the workspace', () => {
  assert.match(dashboard, /import \{ MeanVcPanel \} from '@\/components\/MeanVcPanel'/);
  assert.match(
    dashboard,
    /<main\b[^>]*>[\s\S]*<MeanVcPanel \/>[\s\S]*aria-label="Live streaming preview"/,
  );
});

test('MorphlyVC controls use local preload, preparation, start, and stop endpoints', () => {
  for (const route of ['status', 'reference', 'prepare', 'start', 'pitch', 'stop']) {
    assert.match(panel, new RegExp(`/api/local/meanvc/${route}`));
    assert.match(server, new RegExp(`/api/local/meanvc/${route}`));
  }
  assert.match(panel, /I have permission to use this voice responsibly/);
  assert.match(panel, /Start voice conversion/);
  assert.match(panel, /startRequirement/);
  assert.match(panel, /Quality · 160 ms buffer/);
  assert.match(panel, /engineReady/);
  assert.match(panel, /Voice pitch/);
  assert.match(panel, /pitchSemitones/);
  assert.match(panel, /Microphone input/);
  assert.match(panel, /getSelectableMicrophoneInputs/);
  assert.match(panel, /Converted voice output/);
  assert.match(runtimeController, /input_device: requestedInput/);
  assert.match(runtimeController, /output_device: requestedOutput/);
  assert.match(runtimeController, /--serve/);
  assert.doesNotMatch(runtimeController, /bundledPython, \[bundledBridge, '--check'\]/);
  assert.match(runtimeController, /\[Devices\] Ready/);
  assert.match(fs.readFileSync(realtimeBridge, 'utf8'), /\[Devices\] Ready/);
  assert.match(runtimeController, /engineState/);
  assert.match(panel, /Microphone remains closed until Start/);
  assert.match(panel, /morphly-voice-settings/);
  assert.match(dashboardStyles, /\.morphly-dashboard \.morphly-voice-settings\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/);
  assert.match(server, /requireLocalMeanVcRequest/);
  assert.equal(fs.existsSync(realtimeBridge), true);
  assert.match(runtimeController, /meanvc-realtime\.py/);
  assert.match(runtimeController, /\[Stream\] Running/);
  assert.match(runtimeController, /'--steps', '2'/);
  assert.match(bridge, /class BufferedVoiceStream/);
  assert.match(bridge, /morphlyvc-audio-worker/);
  assert.match(bridge, /self\.output_queue\.qsize\(\) < self\.target_output_blocks/);
  assert.match(bridge, /self\.target_output_blocks = 1/);
  assert.match(bridge, /queue\.Queue\(maxsize=1\)/);
  assert.match(bridge, /queue\.Queue\(maxsize=2\)/);
  assert.match(bridge, /latency="low"/);
  assert.match(bridge, /WasapiSettings\(auto_convert=True\)/);
  assert.match(bridge, /quality="HQ"/);
  assert.match(bridge, /MODEL_BLOCK_MS = 80/);
  assert.match(bridge, /AUDIO_BLOCK_MS = 160/);
  assert.match(bridge, /range\(0, self\.chunk_size, self\.model_chunk_size\)/);
  assert.doesNotMatch(bridge, /audio_stream\.close\(\)/);
});

test('the desktop release bundles, warms, and controls MorphlyVC without localhost', () => {
  assert.match(electronMain, /createMeanVcRuntimeController/);
  assert.match(electronMain, /process\.resourcesPath, 'morphlyvc', 'runtime-40ms'/);
  assert.match(electronMain, /morphlyVcRuntime = createMorphlyVcController\(\)/);
  assert.match(electronMain, /MorphlyVC controls are available only from the Morphly dashboard/);
  for (const action of ['status', 'reference', 'prepare', 'start', 'pitch', 'stop']) {
    assert.match(electronMain, new RegExp(`morphlyvc:${action}`));
    assert.match(electronPreload, new RegExp(`morphlyvc:${action}`));
  }
  assert.match(panel, /window\.location\.protocol === 'file:'/);
  assert.match(panel, /requestMorphlyVc/);
  assert.match(runtimeController, /bundledRuntimeRoot = path\.join/);

  assert.match(packageConfig.build.files.join('\n'), /server\/meanvc-runtime\.js/);
});

test('the voice engine is an optional download instead of a bundled 2.8 GB resource', () => {
  const extras = packageConfig.build.extraResources;

  // The Python runtime must not ship inside the installer any more.
  assert.equal(
    extras.some(({ to }) => String(to).startsWith('morphlyvc/runtime-40ms')),
    false,
  );
  // The small Python bridge still ships so the engine can be launched.
  assert.ok(extras.some(({ to }) => to === 'morphlyvc/meanvc-realtime.py'));

  const installerSource = fs.readFileSync(
    path.join(appDirectory, 'electron/voice-engine-installer.js'),
    'utf8',
  );
  assert.match(installerSource, /morphlyvc-runtime-40ms\.zip/);
  assert.match(installerSource, /releases\/latest\/download/);
  assert.match(installerSource, /sha256/);

  // Electron must expose install status/progress to the renderer.
  assert.match(electronMain, /morphlyvc:engine-status/);
  assert.match(electronMain, /morphlyvc:install-engine/);
  assert.match(electronMain, /morphlyvc:install-progress/);
  assert.match(electronPreload, /morphlyvc:engine-status/);
  assert.match(electronPreload, /morphlyvc:install-engine/);
  assert.match(electronPreload, /morphlyvc:install-progress/);

  // A user-installed runtime under userData wins over any bundled copy.
  assert.match(electronMain, /resolveVoiceEngineRuntimeRoot/);
  assert.match(electronMain, /isVoiceEngineInstalled\(dataRoot\)/);

  // The panel offers the install affordance when the engine is missing.
  assert.match(panel, /Install voice engine/);
  assert.match(panel, /morphlyvc:engine-status/);
});

test('virtual microphone routing detects VB-CABLE and provides compliant setup guidance', () => {
  assert.match(panel, /CABLE Input/);
  assert.match(panel, /CABLE Output/);
  assert.match(panel, /isMultiChannelVirtualCableDevice/);
  assert.match(panel, /Install VB-CABLE, then refresh the device list/);
  assert.match(panel, /virtualMicrophoneOutput\?\.id/);
  assert.match(electronMain, /https:\/\/vb-audio\.com\/Cable\//);
  assert.match(electronPreload, /virtual-microphone:open-setup/);
});
