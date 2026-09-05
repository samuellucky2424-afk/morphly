import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMeanVcRuntimeController } from '../server/meanvc-runtime.js';

test('bundled status and Start never run legacy Python probes or reload the warm engine', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphly-voice-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime-40ms');
  const referenceId = '11111111-1111-4111-8111-111111111111';
  const files = ['python.exe', 'src/vc_pipeline_jit.py', 'models/18_asr_jit_warm.pt', 'models/hq1W_v2_40ms_40ms_gtm_32_run4_newasr_e18_l6_asr2_en_zh_alldata/model_750000_jit.pt'];
  for (const file of files) { const target = path.join(runtime, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture'); }
  fs.mkdirSync(path.join(root, 'references'));
  fs.writeFileSync(path.join(root, 'references', `${referenceId}.wav`), 'fixture');
  const bridge = path.join(root, 'bridge.py'); fs.writeFileSync(bridge, 'fixture');
  let starts = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {}; child.pid = 123;
  const controller = createMeanVcRuntimeController({ repositoryRoot: root, dataRoot: root, bundledRuntimeRoot: runtime, bundledBridge: bridge,
    spawnProcess: () => { starts++; return child; }, findPythonImpl: () => assert.fail('legacy Python probe must not run') });
  t.after(() => controller.shutdown());
  child.stdout.write('[Devices] Ready '+JSON.stringify({defaultInput:1,defaultOutput:2,inputs:[{id:1}],outputs:[{id:2}]})+'\n[Engine] Ready microphone=closed\n');
  for (let i=0;i<20;i++) assert.equal(controller.getStatus().preload.microphoneOpen,false);
  assert.equal(starts,1);
  controller.start({model:'40ms',device:'cpu',referenceId,inputDevice:1,outputDevice:2});
  assert.equal(starts,1);
  child.stdout.write('[Performance] {"processingMs":100,"p95Ms":110}\n');
  assert.equal(controller.getStatus().runtime.performance.p95Ms,110);
  child.stdout.write('[Stream] Stopped\n[Engine] Ready microphone=closed\n');
  assert.equal(controller.getStatus().runtime.performance,null);
  assert.equal(controller.getStatus().preload.microphoneOpen,false);
});
