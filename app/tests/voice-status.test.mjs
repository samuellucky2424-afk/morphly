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


test('translated runtime routes audio through the relay, excludes tokens from status and shuts down both paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphly-translation-runtime-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const runtime = path.join(root,'runtime-40ms');
  for (const file of ['python.exe','src/vc_pipeline_jit.py','models/18_asr_jit_warm.pt','models/hq1W_v2_40ms_40ms_gtm_32_run4_newasr_e18_l6_asr2_en_zh_alldata/model_750000_jit.pt']) {
    const target=path.join(runtime,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'fixture');
  }
  const bridge=path.join(root,'bridge.py');fs.writeFileSync(bridge,'fixture');
  const referenceId='11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(path.join(root,'references'));fs.writeFileSync(path.join(root,'references',referenceId+'.wav'),'fixture');
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  let callbacks, closes=0;const sent=[],commands=[];
  child.stdin.on('data',chunk=>commands.push(JSON.parse(chunk.toString())));
  const controller=createMeanVcRuntimeController({repositoryRoot:root,dataRoot:root,bundledRuntimeRoot:runtime,bundledBridge:bridge,
    spawnProcess:()=>child,connectTranslationImpl:options=>{callbacks=options;return {ready:Promise.resolve(),send:message=>sent.push(message),close:()=>closes++};}});
  t.after(()=>controller.shutdown());
  child.stdout.write('[Devices] Ready '+JSON.stringify({inputs:[{id:1,name:'Physical microphone'},{id:3,name:'CABLE-B Output'}],outputs:[{id:2,name:'CABLE Input'},{id:4,name:'Headphones'}]})+'\n[Engine] Ready\n');
  const settings={model:'40ms',device:'cpu',referenceId,inputDevice:1,outputDevice:2,translation:{enabled:true,targetLanguage:'es',incoming:true,incomingDevice:3,headphonesDevice:4,gatewayUrl:'wss://test.example/api/translation/live',accessToken:'secret-test-token'}};
  await controller.start(settings);
  assert.equal(commands.at(-1).translation.sourceLanguage,'en');
  assert.equal(commands.at(-1).translation.targetLanguage,'es');
  assert.equal(JSON.stringify(controller.getStatus()).includes('secret-test-token'),false);
  assert.equal(JSON.stringify(commands).includes('secret-test-token'),false);
  child.stdout.write('[TranslationAudio] {"type":"audio","direction":"outgoing","data":"AAAAAA=="}\n');
  assert.equal(sent[0].direction,'outgoing');
  assert.equal(controller.getStatus().runtime.logs.some(log=>log.message.includes('AAAAAA==')),false);
  callbacks.onAudio({type:'audio',direction:'outgoing',data:'AAAAAA=='});
  assert.equal(commands.at(-1).type,'translation-audio');
  child.stdout.write('[Stream] Running\n');
  const commandCount = commands.length;
  callbacks.onState('reconnecting');
  assert.equal(controller.getStatus().runtime.state, 'running');
  assert.match(controller.getStatus().runtime.message, /Reconnecting translation/);
  assert.equal(commands.length, commandCount); // No Python stop/start or model reload.
  callbacks.onState('connected');
  assert.match(controller.getStatus().runtime.message, /translation are live/);
  controller.stop();assert.equal(closes,1);
  assert.equal(commands.at(-1).type,'stop');
  child.stdout.write('[Stream] Stopped\n');
  controller.start({...settings,translation:{enabled:false}});
  assert.equal(commands.at(-1).translation,null);
});
