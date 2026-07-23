import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isFlutterwaveTestKey,
  validateFlutterwaveEnvironment,
  validateFlutterwaveTransaction,
} from '../server/flutterwave-payment.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

test('verified transaction qualification requires NGN and positive value', () => {
  assert.equal(validateFlutterwaveTransaction({
    tx_ref: 'morphly_ref',
    currency: 'NGN',
    amount: 1000,
  }, 'morphly_ref').ok, true);
  assert.equal(validateFlutterwaveTransaction({
    tx_ref: 'morphly_ref',
    currency: 'USD',
    amount: 1000,
  }, 'morphly_ref').ok, false);
  assert.equal(validateFlutterwaveTransaction({
    tx_ref: 'morphly_ref',
    currency: 'NGN',
    amount: 0,
  }, 'morphly_ref').ok, false);
});

test('payment reference mismatch is rejected', () => {
  assert.match(
    validateFlutterwaveTransaction({
      tx_ref: 'unexpected',
      currency: 'NGN',
      amount: 1000,
    }, 'expected').message,
    /reference mismatch/i,
  );
});

test('test Flutterwave keys are identified', () => {
  assert.equal(isFlutterwaveTestKey('FLWSECK_TEST-example-X'), true);
  assert.equal(isFlutterwaveTestKey('FLWSECK-example-X'), false);
});

test('test-mode configuration is rejected in production', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalFlutterwaveMode = process.env.FLUTTERWAVE_MODE;
  process.env.NODE_ENV = 'production';
  delete process.env.FLUTTERWAVE_MODE;

  try {
    const result = validateFlutterwaveEnvironment('FLWSECK_TEST-example-X');
    assert.equal(result.ok, false);
    assert.match(result.message, /disabled in production/i);
  } finally {
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
    if (originalFlutterwaveMode === undefined) delete process.env.FLUTTERWAVE_MODE;
    else process.env.FLUTTERWAVE_MODE = originalFlutterwaveMode;
  }
});

test('both deployment roots preserve raw Flutterwave webhook bytes', () => {
  const rootWebhook = fs.readFileSync(
    path.resolve(currentDirectory, '../../api/flutterwave-webhook.ts'),
    'utf8',
  );
  const appWebhook = fs.readFileSync(
    path.resolve(currentDirectory, '../api/flutterwave-webhook.ts'),
    'utf8',
  );
  const localServer = fs.readFileSync(path.resolve(currentDirectory, '../server.js'), 'utf8');
  assert.match(rootWebhook, /bodyParser: false/);
  assert.match(appWebhook, /bodyParser: false/);
  assert.match(localServer, /req\.rawBody = Buffer\.from\(buffer\)/);
});
