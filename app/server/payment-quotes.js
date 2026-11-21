import { createHmac, timingSafeEqual } from 'node:crypto';
import { getUsdExchangeRates } from './exchange-rates.js';

const MARKETS = [
  { country: 'NG', name: 'Nigeria', currency: 'NGN', digits: 2,
    options: 'card,banktransfer,ussd', methods: ['Card', 'Bank transfer', 'USSD'] },
  { country: 'CM', name: 'Cameroon', currency: 'XAF', digits: 0,
    options: 'mobilemoneyxaf', methods: ['Mobile Money'] },
  { country: 'KE', name: 'Kenya', currency: 'KES', digits: 2,
    options: 'card, mpesa', methods: ['Card', 'M-Pesa'] },
  { country: 'GB', name: 'United Kingdom', currency: 'GBP', digits: 2,
    options: 'card', methods: ['Card'] },
  { country: 'US', name: 'United States', currency: 'USD', digits: 2,
    options: 'card', methods: ['Card'] },
];

export function enabledPaymentMarkets() {
  const countries = new Set((process.env.FLUTTERWAVE_LOCAL_COUNTRIES || '').split(',')
    .map((code) => code.trim().toUpperCase()));
  const canConvert = Boolean(process.env.EXCHANGE_RATE_API_KEY?.trim()) &&
    process.env.MORPHLY_PAYMENT_MODE !== 'sandbox';
  return MARKETS.filter(({ country }) => country === 'NG' || (canConvert && countries.has(country)));
}

const quoteSignature = (body, key) => createHmac('sha256', key)
  .update(`morphly-payment-quote-v1:${body}`).digest('base64url');

export async function createPaymentQuote(market, { userId, packageId, amountNGN, credits }, key) {
  let rate = 1;
  if (market.currency !== 'NGN') {
    const { rates } = await getUsdExchangeRates();
    rate = rates[market.currency] / rates.NGN;
  }
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Exchange rate unavailable');
  const amount = Number((amountNGN * rate).toFixed(market.digits));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid converted amount');
  const quote = {
    userId, packageId, amountNGN, credits, country: market.country, currency: market.currency,
    amount, rate, expiresAt: Date.now() + 5 * 60 * 1000,
  };
  const body = Buffer.from(JSON.stringify(quote)).toString('base64url');
  return { ...quote, methods: market.methods, token: `${body}.${quoteSignature(body, key)}` };
}

export function readPaymentQuote(token, market, checkout, key) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(quoteSignature(body, key));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const quote = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (quote.expiresAt <= Date.now() || quote.country !== market.country ||
      quote.currency !== market.currency || quote.userId !== checkout.userId ||
      quote.packageId !== checkout.packageId || quote.amountNGN !== checkout.amountNGN ||
      quote.credits !== checkout.credits) return null;
  return quote;
}
