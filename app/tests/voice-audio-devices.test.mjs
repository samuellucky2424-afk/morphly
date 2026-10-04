import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMeanVcRuntimeController } from '../server/meanvc-runtime.js';
import { selectableVoiceOutputs } from '../shared/voice-audio-devices.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'morphly-audio-refresh-'));
  const runtime=path.join(root,'runtime-40ms');
  for(const file of ['python.exe','src/vc_pipeline_jit.py','models/18_asr_jit_warm.pt','models/hq1W_v2_40ms_40ms_gtm_32_run4_newasr_e18_l6_asr2_en_zh_alldata/model_750000_jit.pt']) {
    const target=path.join(runtime,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'fixture');
  }
  const bridge=path.join(root,'bridge.py');fs.writeFileSync(bridge,'fixture');
  const children=[];
  const controller=createMeanVcRuntimeController({repositoryRoot:root,dataRoot:root,bundledRuntimeRoot:runtime,bundledBridge:bridge,
    findPythonImpl:()=>assert.fail('No legacy probes'), spawnProcess:()=>{
      const child=new EventEmitter(); child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
      child.killed=0;child.kill=()=>{child.killed++;return true;};children.push(child);return child;
    }});
  t.after(()=>{controller.shutdown();fs.rmSync(root,{recursive:true,force:true});});
  return {controller,children};
}
const devices={defaultInput:1,defaultOutput:2,inputName:'Mic',outputName:'Speakers',inputCount:1,outputCount:1,
  inputs:[{id:1,name:'Mic',hostapi:'Windows WASAPI'}],outputs:[{id:2,name:'Speakers',hostapi:'Windows WASAPI'}]};
const report=(child,value=devices)=>child.stdout.write('[Devices] Ready '+JSON.stringify(value)+'\n');

test('speakers remain selectable without a microphone; selected duplex devices use the same driver',()=>{
  assert.deepEqual(selectableVoiceOutputs({...devices,inputs:[]},null),devices.outputs);
  assert.deepEqual(selectableVoiceOutputs(devices,999),devices.outputs);
  const mixed={...devices,outputs:[...devices.outputs,{id:3,name:'Other driver',hostapi:'MME'},{id:4,name:'CABLE In 16ch',hostapi:'Windows WASAPI'}]};
  assert.deepEqual(selectableVoiceOutputs(mixed,1),devices.outputs);
  assert.equal(selectableVoiceOutputs(mixed,null).length,2);
});

test('refresh starts a new device scan only after the old worker exits, replacing cached IDs',t=>{
  const {controller,children}=fixture(t);report(children[0]);children[0].stdout.write('[Engine] Ready\n');
  assert.equal(controller.getStatus().standalone['40ms'].audioDevices.defaultInput,1);
  assert.equal(controller.refreshDevices().standalone['40ms'].audioDevices,null);
  controller.refreshDevices();assert.equal(children[0].killed,1);assert.equal(children.length,1);
  children[0].emit('exit',null,'SIGTERM');assert.equal(children.length,2);
  report(children[1],{...devices,defaultInput:7,inputs:[{id:7,name:'USB microphone',hostapi:'Windows WASAPI'}]});
  children[1].stdout.write('[Engine] Ready\n');
  assert.equal(controller.getStatus().standalone['40ms'].audioDevices.defaultInput,7);
  assert.equal(controller.getStatus().preload.microphoneOpen,false);
});

test('refresh cannot kill an active microphone stream or reference preparation',t=>{
  const {controller,children}=fixture(t);report(children[0]);children[0].stdout.write('[Engine] Ready\n[Stream] Running\n');
  assert.throws(()=>controller.refreshDevices(),/Stop voice conversion/);assert.equal(children[0].killed,0);
  children[0].stdout.write('[Stream] Stopped\n[Voice] Loading\n');
  assert.throws(()=>controller.refreshDevices(),/voice preparation/);
});

test('device errors remain visible; permanent model failure has bounded retries and preserves detected audio',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {controller,children}=fixture(t);report(children[0]);
  for(let i=0;i<4;i++){
    children[i].stderr.write('OSError: model DLL could not load\n');children[i].emit('exit',1,null);
    if(i<3){assert.equal(controller.getStatus().preload.engineState,'loading');t.mock.timers.tick(1500*2**i);}
  }
  t.mock.timers.tick(60000);assert.equal(children.length,4);
  assert.equal(controller.getStatus().preload.engineState,'failed');
  assert.match(controller.getStatus().preload.engineMessage,/model DLL could not load/);
  assert.equal(controller.getStatus().standalone['40ms'].audioDevices.defaultOutput,2);
  controller.refreshDevices();assert.equal(children.length,5);
  children[4].stderr.write('[Devices] Error Windows audio service unavailable\n');
  assert.match(controller.getStatus().standalone['40ms'].audioDeviceError,/audio service/);
  report(children[4]);assert.equal(controller.getStatus().standalone['40ms'].audioDeviceError,null);
});
