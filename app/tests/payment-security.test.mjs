import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FLUTTERWAVE_MAIN_SHARE,
  FLUTTERWAVE_SAVINGS_SHARE,
  initiateFlutterwavePayment,
  isFlutterwaveTestKey,
  validateFlutterwaveEnvironment,
  validateFlutterwaveTransaction,
  verifyFlutterwaveTransactionByReference,
} from '../server/flutterwave-payment.js';
import initiateFlutterwavePaymentHandler from '../server/api/initiate-flutterwave-payment.ts';

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

test('Flutterwave Standard initiation enforces 60% main and 40% savings settlement', async () => {
  const originalFetch = globalThis.fetch;
  let receivedRequest;

  globalThis.fetch = async (url, options) => {
    receivedRequest = {
      url,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(JSON.stringify({
      status: 'success',
      data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/test-link' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await initiateFlutterwavePayment({
      userId: '11111111-1111-1111-1111-111111111111',
      email: 'customer@example.com',
      customerName: 'Morphly Customer',
      amountNGN: 23000,
      credits: 1000,
      packageId: '22222222-2222-2222-2222-222222222222',
      priceUSD: 15.33,
      reference: 'morphly_1787688000000_abc1234',
      redirectUrl: 'https://morphly.example/#/subscription',
      linkExpiration: '2030-01-01T00:30:00.000Z',
      secretKey: 'FLWSECK-live-example-X',
      savingsSubaccountId: 'RS_SAVINGS123',
    });

    assert.equal(receivedRequest.url, 'https://api.flutterwave.com/v3/payments');
    assert.equal(receivedRequest.method, 'POST');
    assert.equal(receivedRequest.headers.Authorization, 'Bearer FLWSECK-live-example-X');
    assert.deepEqual(receivedRequest.body, {
      tx_ref: 'morphly_1787688000000_abc1234',
      amount: 23000,
      currency: 'NGN',
      redirect_url: 'https://morphly.example/#/subscription',
      link_expiration: '2030-01-01T00:30:00.000Z',
      payment_options: 'card,banktransfer,ussd',
      customer: {
        email: 'customer@example.com',
        name: 'Morphly Customer',
      },
      meta: {
        userId: '11111111-1111-1111-1111-111111111111',
        credits: 1000,
        packageId: '22222222-2222-2222-2222-222222222222',
        priceUSD: 15.33,
      },
      customizations: {
        title: 'Morphly Credits',
        description: 'Purchase 1000 credits',
      },
      subaccounts: [{
        id: 'RS_SAVINGS123',
        transaction_charge_type: 'percentage',
        transaction_charge: 0.60,
      }],
    });
    assert.equal(FLUTTERWAVE_MAIN_SHARE, 0.60);
    assert.equal(FLUTTERWAVE_SAVINGS_SHARE, 0.40);
    assert.equal(1 - receivedRequest.body.subaccounts[0].transaction_charge, FLUTTERWAVE_SAVINGS_SHARE);
    assert.equal('transaction_split_ratio' in receivedRequest.body.subaccounts[0], false);
    assert.equal(result.reference, 'morphly_1787688000000_abc1234');
    assert.equal(result.checkoutUrl, 'https://checkout.flutterwave.com/v3/hosted/pay/test-link');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Flutterwave initiation refuses to create an unsplit payment when the savings subaccount is missing', async () => {
  const originalSubaccountId = process.env.FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  delete process.env.FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };

  try {
    await assert.rejects(
      initiateFlutterwavePayment({
        userId: '11111111-1111-1111-1111-111111111111',
        email: 'customer@example.com',
        amountNGN: 23000,
        credits: 1000,
        packageId: '22222222-2222-2222-2222-222222222222',
        reference: 'morphly_1787688000000_missing',
        redirectUrl: 'https://morphly.example/#/subscription',
        secretKey: 'FLWSECK-live-example-X',
      }),
      /refusing to create an unsplit Flutterwave payment/i,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSubaccountId === undefined) delete process.env.FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID;
    else process.env.FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID = originalSubaccountId;
  }
});

test('Flutterwave can verify a retained checkout by its server-generated reference', async () => {
  const originalFetch = globalThis.fetch;
  let receivedRequest;

  globalThis.fetch = async (url, options) => {
    receivedRequest = { url, options };
    return new Response(JSON.stringify({
      status: 'success',
      data: {
        id: 987654,
        tx_ref: 'morphly_1787688000000_reference',
        status: 'successful',
        amount: 23000,
        currency: 'NGN',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const verification = await verifyFlutterwaveTransactionByReference(
      'morphly_1787688000000_reference',
      'FLWSECK-live-example-X',
    );
    assert.equal(
      receivedRequest.url,
      'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=morphly_1787688000000_reference',
    );
    assert.equal(receivedRequest.options.method, 'GET');
    assert.equal(verification.isVerified, true);
    assert.equal(verification.transaction.id, 987654);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Flutterwave return route reports to the retained Morphly window without exposing credentials', async () => {
  const originalPublicAppUrl = process.env.VITE_PUBLIC_APP_URL;
  process.env.VITE_PUBLIC_APP_URL = 'https://morphly.example';

  const headers = new Map();
  let statusCode;
  let responseBody;
  const response = {
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    status(value) {
      statusCode = value;
      return this;
    },
    send(value) {
      responseBody = value;
      return this;
    },
  };

  try {
    await initiateFlutterwavePaymentHandler({
      method: 'GET',
      headers: {
        host: 'api.morphly.example',
        'x-forwarded-proto': 'https',
      },
      query: {
        status: 'successful',
        tx_ref: 'morphly_1787688000000_return',
        transaction_id: '987654',
      },
      url: '/api/flutterwave-payment-return',
    }, response);

    assert.equal(statusCode, 200);
    assert.match(headers.get('content-security-policy'), /script-src 'nonce-/);
    assert.match(responseBody, /morphly:flutterwave-return/);
    assert.match(responseBody, /window\.opener\.postMessage/);
    assert.match(responseBody, /window\.close\(\)/);
    assert.doesNotMatch(responseBody, /FLWSECK|FLUTTERWAVE_SECRET_KEY/);
  } finally {
    if (originalPublicAppUrl === undefined) delete process.env.VITE_PUBLIC_APP_URL;
    else process.env.VITE_PUBLIC_APP_URL = originalPublicAppUrl;
  }
});

test('split rollout retains the main app window and disables legacy unsplit Inline configuration', () => {
  const subscription = fs.readFileSync(
    path.resolve(currentDirectory, '../src/pages/Subscription.tsx'),
    'utf8',
  );
  const publicConfig = fs.readFileSync(
    path.resolve(currentDirectory, '../server/api/public-config.ts'),
    'utf8',
  );
  const apiRouter = fs.readFileSync(
    path.resolve(currentDirectory, '../server/api-router.js'),
    'utf8',
  );

  assert.match(subscription, /window\.open\(/);
  assert.doesNotMatch(subscription, /window\.location\.assign\(data\.checkoutUrl\)/);
  assert.match(subscription, /pendingPayment\.reference !== paymentReturn\.reference/);
  assert.match(publicConfig, /flutterwavePublicKey: ''/);
  assert.match(publicConfig, /Cache-Control', 'no-store, max-age=0/);
  assert.match(apiRouter, /'flutterwave-payment-return': initiateFlutterwavePaymentHandler/);
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
