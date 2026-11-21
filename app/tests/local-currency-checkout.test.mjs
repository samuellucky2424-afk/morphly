import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentQuote, enabledPaymentMarkets, readPaymentQuote } from '../server/payment-quotes.js';
import {
  buildFlutterwaveStandardPaymentPayload,
  validateFlutterwaveTransaction,
} from '../server/flutterwave-payment.js';
import { createPaymentRuntime } from '../server/firebase-payment-runtime.mjs';
import { createMemoryFirestore } from './helpers/memory-firestore.mjs';

test('Cameroon checkout quotes whole XAF and settles the quoted credits once', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    result: 'success', base_code: 'USD', conversion_rates: { NGN: 1500, XAF: 660.1 },
  }));
  const previous = { ...process.env };
  t.after(() => {
    for (const key of ['EXCHANGE_RATE_API_KEY', 'FLUTTERWAVE_LOCAL_COUNTRIES', 'MORPHLY_PAYMENT_MODE']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.EXCHANGE_RATE_API_KEY = 'mock-exchange-key';
  process.env.MORPHLY_PAYMENT_MODE = 'live';
  delete process.env.FLUTTERWAVE_LOCAL_COUNTRIES;
  assert.deepEqual(enabledPaymentMarkets().map(({ country }) => country), ['NG']);
  process.env.FLUTTERWAVE_LOCAL_COUNTRIES = 'CM';
  const cameroon = enabledPaymentMarkets().find(({ country }) => country === 'CM');

  const checkout = { userId: 'buyer', packageId: 'starter', amountNGN: 12750, credits: 500 };
  const signingKey = 'mock-checkout-signing-key';
  const quote = await createPaymentQuote(cameroon, checkout, signingKey);
  assert.equal(quote.amount, 5611);
  assert.equal(quote.currency, 'XAF');
  assert.equal(readPaymentQuote(quote.token, cameroon, checkout, signingKey).amount, 5611);
  assert.equal(readPaymentQuote(quote.token + 'x', cameroon, checkout, signingKey), null);
  assert.equal(readPaymentQuote(quote.token, cameroon, { ...checkout, userId: 'another' }, signingKey), null);
  assert.equal(readPaymentQuote(quote.token, cameroon, { ...checkout, amountNGN: 13000 }, signingKey), null);
  const dateNow = t.mock.method(Date, 'now', () => quote.expiresAt);
  assert.equal(readPaymentQuote(quote.token, cameroon, checkout, signingKey), null);
  dateNow.mock.restore();

  const reference = 'morphly-local-currency-test';
  const payload = buildFlutterwaveStandardPaymentPayload({
    ...checkout, amount: quote.amount, currency: quote.currency, paymentOptions: cameroon.options,
    email: 'buyer@example.com', reference, redirectUrl: 'https://morphly.example/api/flutterwave-payment-return',
    linkExpiration: new Date(quote.expiresAt).toISOString(), savingsSubaccountId: 'RS_TEST',
  });
  assert.equal(payload.currency, 'XAF');
  assert.equal(payload.amount, 5611);
  assert.equal(payload.payment_options, 'mobilemoneyxaf');
  assert.equal(payload.subaccounts[0].transaction_charge, 0.6);

  const verified = { tx_ref: reference, currency: 'XAF', amount: 5611 };
  const validation = validateFlutterwaveTransaction(verified, reference, quote);
  assert.equal(validation.ok, true);
  assert.equal(validation.amountPaidNGN, 12750);
  assert.equal(validateFlutterwaveTransaction({ ...verified, currency: 'NGN' }, reference, quote).ok, false);
  assert.equal(validateFlutterwaveTransaction({ ...verified, amount: 5610 }, reference, quote).ok, false);
  assert.equal(validateFlutterwaveTransaction({ ...verified, tx_ref: undefined }, reference, quote).ok, false);

  const db = createMemoryFirestore();
  await db.collection('users').doc('buyer').set({ id: 'buyer', account_status: 'active' });
  await db.collection('credit_packages').doc('starter').set({ status: 'inactive', credits: 700, price_ngn: 15000 });
  const paymentRuntime = createPaymentRuntime(db);
  const payment = {
    userId: 'buyer', packageId: 'starter', reference, gateway: 'flutterwave', gatewayId: 'charge-1',
    amount: validation.amountPaidNGN,
    checkout: { ...quote, packageName: 'Starter', amountPaid: validation.amountPaid, gatewayFee: 0 },
  };
  const result = await paymentRuntime.applyPayment(payment);
  const duplicate = await paymentRuntime.applyPayment(payment);
  const transaction = (await db.collection('transactions').doc(result.transactionId).get()).data();
  assert.equal(result.creditsAdded, 500);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.newCredits, 500);
  assert.equal(transaction.amount_naira, '12750.00');
  assert.equal(transaction.payment_amount, 5611);
  assert.equal(transaction.payment_currency, 'XAF');
  assert.equal((await db.collection('wallet_ledger').get()).size, 1);
});
