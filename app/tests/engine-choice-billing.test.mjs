import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as provider from '../src/lib/realtime-provider.ts';
import startSession from '../server/api/start-session.ts';

const source = readFileSync(new URL('../src/lib/billing.ts', import.meta.url), 'utf8');
const context = vm.createContext({ exports: {}, require: () => provider });
vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const billing = context.exports;

test('Pro (Vidu) costs 2.5 cr/sec and Plus (Xmax) costs 2 regardless of background selection', () => {
  for (const image of [true, false]) for (const background of [true, false]) {
    assert.equal(billing.getCreditRatePerSecond(image, background, 'vidu'), 2.5);
    assert.equal(billing.getCreditRatePerSecond(image, background, 'xmax'), 2);
  }
  assert.equal(billing.getBillableUsageUnits(60, false, 'vidu') * 2, 150);
  assert.equal(billing.getBillableUsageUnits(60, false, 'xmax') * 2, 120);
  assert.equal(provider.getMinimumCreditsToStart('xmax', 2), 30);
  assert.equal(provider.getMinimumCreditsToStart('vidu', 2.5), 37.5);
});

test('session API refuses missing or invalid engine choices before any provider call', async () => {
  for (const choice of [undefined, '', 'unknown', 'decart']) {
    let status;
    let body;
    const res = { setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; } };
    await startSession({ method: 'POST', headers: {}, body: { provider: choice } }, res);
    assert.equal(status, 400);
    assert.equal(body.allowed, false);
    assert.match(body.error, /Choose Plus or Pro/);
  }
});

test('server bills Plus at 4 half-credits and Pro at 5, with 15s minimums', async () => {
  const mod = await import('../server/api/start-session.ts');
  assert.deepEqual([mod.REALTIME_ENGINE_RATE_HALF.xmax, mod.REALTIME_ENGINE_RATE_HALF.vidu], [4, 5]);
  assert.equal(mod.getEngineMinimumCredits('xmax'), 30);
  assert.equal(mod.getEngineMinimumCredits('vidu'), 37.5);
});

test('Xmax temporary key is minted server-side with the permanent key only in the header', async () => {
  const mod = await import('../server/api/start-session.ts');
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return Response.json({ success: true, data: { temporaryApiKey: 'tk-abc', expireTimestamp: 2000000000000 } }); };
  const result = await mod.createXmaxTemporaryKey({ apiKey: 'uk-secret', maxSeconds: 100, fetchImpl });
  assert.equal(result.token, 'tk-abc');
  assert.equal(seen.url, 'https://api.xmax.ai/open/api/v1/temporary-api-key');
  assert.equal(seen.init.headers['X-Api-Key'], 'uk-secret');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.temporaryApiKeySessionLimit, 3);
  assert.equal(body.expireSeconds, 220);
  assert.ok(!JSON.stringify(result).includes('uk-secret'));
  const failed = await mod.createXmaxTemporaryKey({ apiKey: 'uk-secret', maxSeconds: 100, fetchImpl: async () => Response.json({ success: false, code: 46019 }, { status: 200 }) });
  assert.ok(failed.error);
});
