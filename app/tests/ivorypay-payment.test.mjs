import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';

import {
  isIvoryPayTestKey,
  validateIvoryPayEnvironment,
  validateIvoryPayTransaction,
  extractIvoryPayPaymentContext,
  hasValidIvoryPaySignature,
} from '../server/ivorypay-payment.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

test('verified IvoryPay transaction qualification requires positive amount', () => {
  assert.equal(validateIvoryPayTransaction({
    reference: 'morphly_crypto_123',
    amount: 15.33,
  }, 'morphly_crypto_123').ok, true);

  assert.equal(validateIvoryPayTransaction({
    reference: 'morphly_crypto_123',
    amount: 0,
  }, 'morphly_crypto_123').ok, false);

  assert.equal(validateIvoryPayTransaction({
    reference: 'morphly_crypto_123',
    amount: -10,
  }, 'morphly_crypto_123').ok, false);
});

test('IvoryPay payment reference mismatch is rejected', () => {
  assert.match(
    validateIvoryPayTransaction({
      reference: 'unexpected_ref',
      amount: 20,
    }, 'expected_ref').message,
    /reference mismatch/i,
  );
});

test('test IvoryPay keys are identified correctly', () => {
  assert.equal(isIvoryPayTestKey('sk_test_abc123456789'), true);
  assert.equal(isIvoryPayTestKey('pk_test_abc123456789'), true);
  assert.equal(isIvoryPayTestKey('sk_live_abc123456789'), false);
  assert.equal(isIvoryPayTestKey('pk_live_abc123456789'), false);
});

test('test-mode IvoryPay configuration is rejected in production', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalIvoryPayMode = process.env.IVORYPAY_MODE;
  process.env.NODE_ENV = 'production';
  delete process.env.IVORYPAY_MODE;

  try {
    const result = validateIvoryPayEnvironment('sk_test_abc123');
    assert.equal(result.ok, false);
    assert.match(result.message, /disabled in production/i);
  } finally {
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
    if (originalIvoryPayMode === undefined) delete process.env.IVORYPAY_MODE;
    else process.env.IVORYPAY_MODE = originalIvoryPayMode;
  }
});

test('extractIvoryPayPaymentContext extracts and validates metadata', () => {
  const context = extractIvoryPayPaymentContext({
    reference: 'morphly_crypto_ref_1',
    metadata: {
      userId: '11111111-1111-1111-1111-111111111111',
      packageId: '22222222-2222-2222-2222-222222222222',
      credits: 1000,
    },
  });

  assert.equal(context.reference, 'morphly_crypto_ref_1');
  assert.equal(context.userId, '11111111-1111-1111-1111-111111111111');
  assert.equal(context.packageId, '22222222-2222-2222-2222-222222222222');
  assert.equal(context.credits, 1000);
});

test('hasValidIvoryPaySignature validates HMAC-SHA256 signatures accurately', () => {
  const secret = 'test_webhook_secret_key_12345';
  const payload = JSON.stringify({
    event: 'transaction.successful',
    data: { reference: 'morphly_crypto_ref_1', amount: 20 },
  });

  const validHexSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const validBase64Sig = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  const invalidSig = 'invalid_signature_hex_1234567890abcdef';

  assert.equal(hasValidIvoryPaySignature(payload, validHexSig, secret), true);
  assert.equal(hasValidIvoryPaySignature(payload, validBase64Sig, secret), true);
  assert.equal(hasValidIvoryPaySignature(payload, invalidSig, secret), false);
  assert.equal(hasValidIvoryPaySignature('', validHexSig, secret), false);
});

test('both deployment roots preserve raw IvoryPay webhook bytes', () => {
  const rootWebhook = fs.readFileSync(
    path.resolve(currentDirectory, '../../api/ivorypay-webhook.ts'),
    'utf8',
  );
  const appWebhook = fs.readFileSync(
    path.resolve(currentDirectory, '../api/ivorypay-webhook.ts'),
    'utf8',
  );
  assert.match(rootWebhook, /bodyParser: false/);
  assert.match(appWebhook, /bodyParser: false/);
});
