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

test('Pro costs 2.5 cr/sec and Plus retains its standard and combined rates', () => {
  for (const engine of ['vidu']) {
    assert.equal(billing.getCreditRatePerSecond(true, false, engine), 2.5);
    assert.equal(billing.getCreditRatePerSecond(true, true, engine), 2.5);
  }
  for (const avatar of [true,false]) for (const background of [true,false]) assert.equal(billing.getCreditRatePerSecond(avatar, background, 'decart'), 2);
  assert.equal(billing.getBillableUsageUnits(60,true,'decart')*2,120);
  assert.equal(billing.getCreditRatePerSecond(true, false, 'xmax'), 2);
  assert.equal(billing.getCreditRatePerSecond(false, true, 'xmax'), 2);
  assert.equal(billing.getCreditRatePerSecond(true, true, 'xmax'), 4);
});

test('fractional Pro usage carries across heartbeat flushes without overcharging', () => {
  let pending = 0;
  let credits = 0;
  for (let elapsed = 5; elapsed <= 60; elapsed += 5) {
    pending += billing.getBillableUsageUnits(5, false, 'vidu');
    const units = Math.floor(pending);
    pending -= units;
    credits += units * 2;
    assert.ok(credits <= elapsed * 2.5);
    assert.ok(elapsed * 2.5 - credits < 2);
  }
  assert.equal(credits, 150);
  assert.equal(pending, 0);
  assert.equal(billing.getBillableUsageUnits(60, false, 'xmax') * 2, 120);
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
