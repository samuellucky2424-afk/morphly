import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/api-client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/import\.meta\.env/g, 'testEnvironment'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

async function requestUrl(protocol, environment = {}) {
  let requested;
  const context = vm.createContext({
    exports: {},
    require: () => ({ supabase: {} }),
    window: { location: { protocol } },
    testEnvironment: environment,
    fetch: async url => { requested = url; return { ok: true }; },
  });
  vm.runInContext(compiled, context);
  await context.exports.apiFetch('/start-session');
  return requested;
}

test('hosted web builds use their own API even when an older production URL is configured', async () => {
  assert.equal(await requestUrl('https:', { VITE_API_URL: 'https://older.example' }), '/api/start-session');
  assert.equal(await requestUrl('https:'), '/api/start-session');
  assert.equal(await requestUrl('http:', { DEV: true }), '/api/start-session');
});

test('packaged desktop builds retain configured and fallback remote API support', async () => {
  assert.equal(await requestUrl('file:', { VITE_API_URL: 'https://desktop.example' }), 'https://desktop.example/api/start-session');
  assert.equal(await requestUrl('file:', { VITE_API_URL: '/api' }), 'https://live.morphly.fun/api/start-session');
  assert.equal(await requestUrl('file:'), 'https://live.morphly.fun/api/start-session');
});

const panel = await readFile(new URL('../src/components/MeanVcPanel.tsx', import.meta.url), 'utf8');
const requestSource = panel.slice(panel.indexOf('function usesPackagedVoiceBridge()'), panel.indexOf('function isVirtualMicrophonePlaybackDevice'));
const compiledVoiceRequest = ts.transpileModule(requestSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

test('hosted voice controls explain desktop availability without issuing a local API request', async () => {
  let requests = 0;
  const context = vm.createContext({
    window: { location: { protocol: 'https:', hostname: 'preview.example' } },
    MORPHLY_VC_ROUTES: { status: { path: '/api/local/meanvc/status', method: 'GET' } },
    fetch: async () => { requests += 1; },
  });
  vm.runInContext(compiledVoiceRequest, context);
  await assert.rejects(context.requestMorphlyVc('status'), /Open Morphly Desktop/);
  assert.equal(requests, 0);
});
