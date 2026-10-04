import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';

test('Decart camera uses Lucy on the Decart SDK and cancels its connection', async () => {
  let credential, options, sets=[], disconnects=0, remote;
  const session={getConnectionState:()=> 'connected',set:async value=>sets.push(value),disconnect:()=>{disconnects++;},on(){},off(){}};
  const sdk={noopLogger:{},models:{realtime:name=>({name})},createDecartClient:config=>{credential=config.apiKey;return {realtime:{connect:async (_stream,input)=>{options=input;return session;}}};}};
  const context=vm.createContext({exports:{},require:name=>{assert.equal(name,'@decartai/sdk');return sdk;},crypto:{randomUUID}});
  vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/lib/decart-client.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  const controller=new AbortController();
  const connection=await context.exports.createViduClient({apiKey:'temporary-decart-only'}).connect({}, {signal:controller.signal,onRemoteStream:stream=>{remote=stream;}});
  assert.equal(credential,'temporary-decart-only');assert.equal(options.model.name,'lucy-2.5');
  const output={};options.onRemoteStream(output);assert.equal(remote,output);
  await connection.set({prompt:' test prompt ',enhance:true,image:'reference'});
  assert.equal(sets[0].prompt,'test prompt');assert.equal(sets[0].image,'reference');
  controller.abort();assert.equal(disconnects,1);remote=null;options.onRemoteStream(output);assert.equal(remote,null);
  await connection.disconnect();assert.equal(disconnects,2);
});
