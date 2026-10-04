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

test('Pro costs 2.5 cr/sec and Plus costs 2 regardless of background selection', () => {
  for (const image of [true, false]) for (const background of [true, false]) {
    assert.equal(billing.getCreditRatePerSecond(image, background, 'decart'), 2.5);
    assert.equal(billing.getCreditRatePerSecond(image, background, 'vidu'), 2);
  }
  assert.equal(billing.getBillableUsageUnits(60, false, 'decart') * 2, 150);
  assert.equal(billing.getBillableUsageUnits(60, false, 'vidu') * 2, 120);
});

test('session API refuses missing or invalid engine choices before any provider call', async () => {
  for (const choice of [undefined, '', 'unknown', 'xmax']) {
    let status;
    let body;
    const res = { setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; } };
    await startSession({ method: 'POST', headers: {}, body: { provider: choice } }, res);
    assert.equal(status, 400);
    assert.equal(body.allowed, false);
    assert.match(body.error, /Choose an engine/);
  }
});
