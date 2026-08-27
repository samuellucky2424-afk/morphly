// @ts-nocheck
import crypto from 'crypto';

import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logPaymentEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import {
  FLUTTERWAVE_MAIN_SHARE,
  FLUTTERWAVE_SAVINGS_SHARE,
  initiateFlutterwavePayment,
} from '../flutterwave-payment.js';

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function resolveRequestOrigin(req) {
  const forwardedHost = String(getHeader(req, 'x-forwarded-host') || getHeader(req, 'host') || '')
    .split(',')[0]
    .trim();
  const forwardedProtocol = String(getHeader(req, 'x-forwarded-proto') || (req.socket?.encrypted ? 'https' : 'http'))
    .split(',')[0]
    .trim();

  try {
    const requestOrigin = new URL(forwardedHost ? `${forwardedProtocol}://${forwardedHost}` : '');
    if (['http:', 'https:'].includes(requestOrigin.protocol)) return requestOrigin.origin;
  } catch {
    // Handled by the configuration error below.
  }

  const error = new Error('Unable to determine the Flutterwave checkout return URL');
  error.code = 'FLUTTERWAVE_CONFIGURATION_ERROR';
  throw error;
}

function resolveFlutterwaveRedirectUrl(req) {
  return new URL('/api/flutterwave-payment-return', resolveRequestOrigin(req)).toString();
}

function getQueryParameter(req, name) {
  const value = req.query?.[name];
  if (Array.isArray(value)) return value[0];
  if (value != null) return value;

  try {
    const requestUrl = new URL(req.originalUrl || req.url || '/', resolveRequestOrigin(req));
    return requestUrl.searchParams.get(name);
  } catch {
    return null;
  }
}

function normalizeReturnValue(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

function resolveFrontendReturnUrl(req, paymentReturn) {
  let appOrigin;
  try {
    const configuredAppUrl = new URL(String(process.env.VITE_PUBLIC_APP_URL || ''));
    appOrigin = ['http:', 'https:'].includes(configuredAppUrl.protocol)
      ? configuredAppUrl.origin
      : resolveRequestOrigin(req);
  } catch {
    appOrigin = resolveRequestOrigin(req);
  }

  const fallbackUrl = new URL(appOrigin);
  if (paymentReturn.status) fallbackUrl.searchParams.set('status', paymentReturn.status);
  if (paymentReturn.reference) fallbackUrl.searchParams.set('tx_ref', paymentReturn.reference);
  if (paymentReturn.transactionId) fallbackUrl.searchParams.set('transaction_id', paymentReturn.transactionId);
  fallbackUrl.hash = '/subscription';
  return fallbackUrl.toString();
}

function handleFlutterwaveReturn(req, res) {
  const paymentReturn = {
    type: 'morphly:flutterwave-return',
    status: normalizeReturnValue(getQueryParameter(req, 'status'), 32).toLowerCase(),
    reference: normalizeReturnValue(getQueryParameter(req, 'tx_ref')),
    transactionId: normalizeReturnValue(getQueryParameter(req, 'transaction_id'), 64),
  };
  const fallbackUrl = resolveFrontendReturnUrl(req, paymentReturn);
  const nonce = crypto.randomBytes(18).toString('base64');
  const serializedReturn = JSON.stringify(paymentReturn).replace(/</g, '\\u003c');
  const serializedFallbackUrl = JSON.stringify(fallbackUrl).replace(/</g, '\\u003c');

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
  );

  return res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Returning to Morphly</title>
    <style>body{margin:0;background:#0a0a0c;color:#f4f4f5;font:16px system-ui;display:grid;place-items:center;min-height:100vh}p{max-width:32rem;text-align:center;padding:2rem}</style>
  </head>
  <body>
    <p>Payment response received. Returning you to Morphly&hellip;</p>
    <script nonce="${nonce}">
      (() => {
        const paymentReturn = ${serializedReturn};
        const fallbackUrl = ${serializedFallbackUrl};
        let delivered = false;
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(paymentReturn, '*');
            delivered = true;
          }
        } catch {}
        if (delivered) window.close();
        window.setTimeout(() => {
          if (!window.closed) window.location.replace(fallbackUrl);
        }, 500);
      })();
    </script>
  </body>
</html>`);
}

function createFlutterwaveReference() {
  const suffix = crypto.randomBytes(5).toString('hex').slice(0, 7);
  return `morphly_${Date.now()}_${suffix}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return handleFlutterwaveReturn(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  let userId = null;
  let packageId = null;
  let reference = null;

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) {
      return res.status(authResult.status).json({ status: 'failed', message: authResult.error });
    }

    const user = authResult.user;
    userId = user.id;
    packageId = String(req.body?.packageId || '').trim();
    const priceUSD = Number(req.body?.priceUSD);

    if (!packageId) {
      return res.status(400).json({ status: 'failed', message: 'A credit package is required' });
    }

    const savingsSubaccountId = String(process.env.FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID || '')
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!savingsSubaccountId) {
      const error = new Error(
        'FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID is not configured; refusing to create an unsplit Flutterwave payment',
      );
      error.code = 'FLUTTERWAVE_CONFIGURATION_ERROR';
      throw error;
    }

    const [packageResult, profileResult] = await Promise.all([
      supabaseAdmin
        .from('credit_packages')
        .select('id, credits, price_ngn, is_active, status')
        .eq('id', packageId)
        .maybeSingle(),
      supabaseAdmin
        .from('users')
        .select('account_status')
        .eq('id', userId)
        .maybeSingle(),
    ]);

    if (packageResult.error) throw packageResult.error;
    if (!packageResult.data) {
      return res.status(404).json({ status: 'failed', message: 'Credit package not found' });
    }
    if (packageResult.data.is_active !== true || String(packageResult.data.status || '').toLowerCase() !== 'active') {
      return res.status(400).json({ status: 'failed', message: 'Credit package is no longer active' });
    }
    if (profileResult.error) throw profileResult.error;
    if (profileResult.data?.account_status === 'suspended') {
      return res.status(403).json({ status: 'failed', message: 'Account suspended' });
    }

    const credits = Number(packageResult.data.credits);
    const amountNGN = Number(packageResult.data.price_ngn);
    if (!Number.isFinite(credits) || credits <= 0 || !Number.isFinite(amountNGN) || amountNGN <= 0) {
      return res.status(500).json({ status: 'failed', message: 'Credit package payment configuration is invalid' });
    }

    reference = createFlutterwaveReference();
    const redirectUrl = resolveFlutterwaveRedirectUrl(req);

    await logRequestEvent('initiate-flutterwave-payment.request', {
      userId,
      packageId,
      reference,
      credits,
      amountNGN,
      currency: 'NGN',
    });
    await logPaymentEvent('flutterwave.split_payment.enabled', {
      message: 'Flutterwave split payment enabled',
      mainShare: `${FLUTTERWAVE_MAIN_SHARE * 100}%`,
      savingsSubaccountShare: `${FLUTTERWAVE_SAVINGS_SHARE * 100}%`,
      subaccount: 'configured',
      userId,
      packageId,
      reference,
    });

    const session = await initiateFlutterwavePayment({
      userId,
      email: user.email,
      customerName: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0],
      amountNGN,
      credits,
      packageId,
      priceUSD: Number.isFinite(priceUSD) && priceUSD > 0 ? priceUSD : undefined,
      reference,
      redirectUrl,
      savingsSubaccountId,
    });

    return res.status(200).json(session);
  } catch (error) {
    const configurationError = error?.code === 'FLUTTERWAVE_CONFIGURATION_ERROR';
    await logErrorEvent(
      configurationError
        ? 'initiate-flutterwave-payment.configuration_error'
        : 'initiate-flutterwave-payment.exception',
      error,
      {
        userId,
        packageId,
        reference,
        providerStatus: Number(error?.providerStatus) || undefined,
        mainShare: '60%',
        savingsSubaccountShare: '40%',
        subaccount: String(process.env.FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID || '').trim()
          ? 'configured'
          : 'missing',
      },
    );

    return res.status(configurationError ? 503 : 502).json({
      status: 'failed',
      message: configurationError
        ? 'Flutterwave checkout is unavailable because split-payment configuration is incomplete'
        : 'Failed to initialize Flutterwave checkout',
    });
  }
}
