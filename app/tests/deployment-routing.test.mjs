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
  assert.equal(await requestUrl('file:', { VITE_API_URL: '/api' }), 'https://morphly-alpha.vercel.app/api/start-session');
  assert.equal(await requestUrl('file:'), 'https://morphly-alpha.vercel.app/api/start-session');
  // Release builds set VITE_PUBLIC_APP_URL to the production origin.
  assert.equal(await requestUrl('file:', { VITE_API_URL: '/api', VITE_PUBLIC_APP_URL: 'https://live.morphly.fun' }),
    'https://live.morphly.fun/api/start-session');
});

test('the voice changer uses the authenticated hosted API on web and desktop', async () => {
  const library = await readFile(new URL('../src/lib/voice-changer.ts', import.meta.url), 'utf8');
  for (const route of ['/voice-voices', '/voice-clone', '/voice-convert', '/voice-delete']) {
    assert.match(library, new RegExp(`apiFetchWithAuth\\('${route}'`));
  }
  assert.doesNotMatch(library, /\/api\/local\/|window\.electron/);
});
