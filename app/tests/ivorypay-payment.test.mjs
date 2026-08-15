import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';

import {
  isIvoryPayTestKey,
  initiateIvoryPayTransaction,
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

test('test-mode IvoryPay configuration is rejected in production when strict blocking is enabled', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalIvoryPayMode = process.env.IVORYPAY_MODE;
  const originalBlockKeys = process.env.IVORYPAY_BLOCK_TEST_KEYS;
  process.env.NODE_ENV = 'production';
  process.env.IVORYPAY_BLOCK_TEST_KEYS = 'true';
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
    if (originalBlockKeys === undefined) delete process.env.IVORYPAY_BLOCK_TEST_KEYS;
    else process.env.IVORYPAY_BLOCK_TEST_KEYS = originalBlockKeys;
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

test('IvoryPay metadata is parsed when its API returns the documented JSON string', () => {
  const context = extractIvoryPayPaymentContext({
    reference: '550e8400-e29b-41d4-a716-446655440000',
    metadata: JSON.stringify({
      userId: '11111111-1111-1111-1111-111111111111',
      packageId: '22222222-2222-2222-2222-222222222222',
      credits: 1000,
    }),
  });

  assert.equal(context.userId, '11111111-1111-1111-1111-111111111111');
  assert.equal(context.packageId, '22222222-2222-2222-2222-222222222222');
  assert.equal(context.credits, 1000);
});

test('IvoryPay validates the paid base-fiat amount, not the crypto token amount', () => {
  const result = validateIvoryPayTransaction({
    reference: '550e8400-e29b-41d4-a716-446655440000',
    amountInBaseFiat: 29000,
    amountInCrypto: 19.93,
  }, '550e8400-e29b-41d4-a716-446655440000');

  assert.equal(result.ok, true);
  assert.equal(result.amountPaidNGN, 29000);
});

test('IvoryPay initiation uses the canonical crypto collection payload', async () => {
  const originalSecret = process.env.IVORYPAY_SECRET_KEY;
  const originalChain = process.env.IVORYPAY_CRYPTO_CHAIN;
  const originalToken = process.env.IVORYPAY_CRYPTO_TOKEN;
  const originalFetch = globalThis.fetch;
  let receivedRequest;

  process.env.IVORYPAY_SECRET_KEY = 'sk_test_example';
  process.env.IVORYPAY_CRYPTO_CHAIN = 'BSC_MAINNET';
  process.env.IVORYPAY_CRYPTO_TOKEN = 'USDT';
  globalThis.fetch = async (url, options) => {
    receivedRequest = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      status: true,
      data: {
        reference: '550e8400-e29b-41d4-a716-446655440000',
        collectionDetails: { network: 'BSC_MAINNET', address: '0x1234' },
        amountInCrypto: 20.14,
        currency: 'USDT',
      },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await initiateIvoryPayTransaction({
      userId: '11111111-1111-1111-1111-111111111111',
      email: 'customer@example.com',
      amountUSD: 21.34,
      priceNGN: 29000,
      credits: 1000,
      packageId: '22222222-2222-2222-2222-222222222222',
      reference: '550e8400-e29b-41d4-a716-446655440000',
    });

    assert.equal(receivedRequest.url, 'https://api.ivorypay.io/api/v1/transactions');
    assert.equal(receivedRequest.headers.Authorization, 'sk_test_example');
    assert.deepEqual(receivedRequest.body, {
      amount: 29000,
      type: 'CRYPTO',
      chain: 'BSC_MAINNET',
      firstName: 'customer',
      lastName: 'User',
      email: 'customer@example.com',
      reference: '550e8400-e29b-41d4-a716-446655440000',
      baseFiat: 'NGN',
      mode: 'API',
      crypto: 'USDT',
      metadata: JSON.stringify({
        userId: '11111111-1111-1111-1111-111111111111',
        packageId: '22222222-2222-2222-2222-222222222222',
        credits: 1000,
        priceUSD: 21.34,
        priceNGN: 29000,
      }),
    });
    assert.deepEqual(result.paymentInstructions, {
      address: '0x1234',
      chain: 'BSC_MAINNET',
      amount: 20.14,
      currency: 'USDT',
      expiresAt: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.IVORYPAY_SECRET_KEY;
    else process.env.IVORYPAY_SECRET_KEY = originalSecret;
    if (originalChain === undefined) delete process.env.IVORYPAY_CRYPTO_CHAIN;
    else process.env.IVORYPAY_CRYPTO_CHAIN = originalChain;
    if (originalToken === undefined) delete process.env.IVORYPAY_CRYPTO_TOKEN;
    else process.env.IVORYPAY_CRYPTO_TOKEN = originalToken;
  }
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

test('hasValidIvoryPaySignature validates IvoryPay HMAC-SHA512 data signatures', () => {
  const secret = 'test_webhook_secret_key_12345';
  const payload = JSON.stringify({ event: 'cryptoCollection.success', data: { reference: 'payment-ref' } });
  const signedData = JSON.stringify({ reference: 'payment-ref' });
  const signature = crypto.createHmac('sha512', secret).update(signedData).digest('hex');

  assert.equal(hasValidIvoryPaySignature(payload, signature, secret, signedData), true);
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
