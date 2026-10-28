import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createXmaxAndroidKey} from '../server/xmax-android-token.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('hosted Android XMax rejects missing authentication before wallet access or provider creation', async () => {
  const compiled = ts.transpileModule(readFileSync(new URL('../server/api/start-session.ts', import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('Must authenticate first'); };
  const exports = {};
  vm.runInNewContext(compiled, {exports, Date, URL, console, process: {env: {XMAX_ANDROID_API_KEY: 'server-secret', VERCEL_ENV: 'production'}},
    require(name) {
      if (name === 'crypto') return {default: {}};
      if (name === '../local-preview.js') return {isLocalPreviewRequest: () => false};
      if (name === '../supabase-admin.js') return {supabaseAdmin: {from: forbidden, rpc: forbidden}};
      if (name === '../../../shared/admin-auth.js') return {authenticateRequestUser: async () => ({status: 401, error: 'Unauthorized'})};
      if (name === '../xmax-android-token.js') return {createXmaxAndroidKey: forbidden};
      return {};
    },
  });
  const response = {setHeader() {}, status(code) { this.code = code; return this; }, json(body) {this.body = body; return this;}};
  await exports.default({method: 'POST', headers: {}, body: {provider: 'xmax', platform: 'android'}}, response);
  assert.equal(response.code, 401);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(response.body).includes('server-secret'), false);
});

test('temporary credential is limited by the authorized session and never returns the server key', async () => {
  let sent;
  const result = await createXmaxAndroidKey({apiKey: 'server-secret', maxSeconds: 30,
    fetchImpl: async (url, request) => {
      sent = {url, body: JSON.parse(request.body)};
      return {ok: true, json: async () => ({success: true, data: {temporaryApiKey: 'temporary-only'}})};
    }});
  assert.equal(sent.url, 'https://api.xmax.cloud/open/api/v1/temporary-api-key');
  assert.deepEqual(sent.body, {expireSeconds: 150, pointsLimit: 30});
  assert.equal(result.token, 'temporary-only');
  assert.equal(result.sessionLimit, 30);
});

test('provider failures and echoed permanent credentials fail closed without exposing secrets', async () => {
  for (const [ok, token] of [[false, 'temporary'], [true, 'server-secret'], [true, null]]) {
    const result = await createXmaxAndroidKey({apiKey: 'server-secret', maxSeconds: 60,
      fetchImpl: async () => ({ok, status: 401, json: async () => ({data: {temporaryApiKey: token}, message: 'server-secret'})})});
    assert.ok(result.error);
    assert.equal(JSON.stringify(result).includes('server-secret'), false);
  }
});
