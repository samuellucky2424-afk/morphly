import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceEngineSetup } from '../electron/voice-engine-setup.js';
import {voiceSetupError} from '../shared/voice-errors.js';
test('voice setup errors show recovery steps instead of encoded PowerShell commands',async()=>{
  const encoded='Command failed: powershell.exe -EncodedCommand '+ 'A'.repeat(10000);
  const setup=createVoiceEngineSetup({isInstalled:()=>false,onInstalled:()=>{},install:async()=>{throw new Error(encoded);}});
  const result=await setup.start();assert.equal(result.success,false);assert.match(result.error,/Retry setup/);assert.ok(result.error.length<200);assert.doesNotMatch(result.error,/EncodedCommand/);
  assert.match(voiceSetupError({stderr:'There is not enough disk space'}),/Free some disk space/);
});

test('startup setup starts immediately and manual clicks join the same download',async()=>{
  let installed=false,calls=0,ready=0,resolveInstall;const events=[];
  const setup=createVoiceEngineSetup({isInstalled:()=>installed,onInstalled:()=>{ready++;},onState:s=>events.push(s),install:async progress=>{
    calls++;progress({phase:'downloading',percent:9,retrying:true,retryDelayMs:2000});
    await new Promise(resolve=>{resolveInstall=resolve;});installed=true;return {installPath:'fixture'};
  }});
  const startup=setup.start();assert.equal(setup.getState().phase,'downloading');
  assert.equal(setup.start(),startup);await Promise.resolve();assert.equal(calls,1);
  // A panel opening after startup sees the current progress, not an empty state.
  assert.equal(setup.getState().percent,9);assert.equal(setup.getState().retrying,true);
  resolveInstall();assert.equal((await startup).success,true);assert.equal(ready,1);
  assert.equal(setup.getState().installed,true);assert.equal(setup.getState().retrying,false);
  await setup.start();assert.equal(calls,1);
});

test('an installed engine is never downloaded again; a failed setup remains retryable',async()=>{
  const installed=createVoiceEngineSetup({isInstalled:()=>true,install:()=>assert.fail('already installed'),onInstalled:()=>assert.fail('already ready')});
  assert.equal((await installed.start()).success,true);
  let complete=false,calls=0;
  const setup=createVoiceEngineSetup({isInstalled:()=>complete,onInstalled:()=>{},install:async()=>{
    if(++calls===1)throw new Error('Not enough disk space');complete=true;return {};
  }});
  assert.equal((await setup.start()).success,false);assert.match(setup.getState().error,/disk space/);
  assert.equal((await setup.start()).success,true);assert.equal(setup.getState().error,null);
});
