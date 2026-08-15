// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logPaymentEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import {
  applyVerifiedIvoryPayPayment,
  extractIvoryPayPaymentContext,
  hasValidIvoryPaySignature,
  validateIvoryPayTransaction,
  verifyIvoryPayTransaction,
} from '../ivorypay-payment.js';

function getHeader(headers, name) {
  const value = headers?.[name.toLowerCase()] || headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ivorypay-signature, x-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError });

  const rawBody = await readRawBody(req);
  const signature = getHeader(req.headers, 'x-ivorypay-signature')
    || getHeader(req.headers, 'x-signature')
    || getHeader(req.headers, 'verif-hash');

  const secret = process.env.IVORYPAY_WEBHOOK_SECRET || process.env.IVORYPAY_SECRET_KEY;

  let eventPayload;
  try {
    eventPayload = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(rawBody || '{}');
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (secret && (!signature || !hasValidIvoryPaySignature(
    rawBody,
    signature,
    secret,
    eventPayload?.data ? JSON.stringify(eventPayload.data) : '',
  ))) {
    await logErrorEvent('ivorypay_webhook.invalid_signature', {
      signatureHeader: Boolean(signature),
      secretConfigured: Boolean(secret),
    });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const eventName = String(eventPayload?.event || eventPayload?.type || eventPayload?.status || '').toLowerCase();
  const transactionData = eventPayload?.data || eventPayload?.transaction || eventPayload;

  await logRequestEvent('ivorypay_webhook.received', {
    event: eventName,
    reference: transactionData?.reference,
    status: transactionData?.status,
  });

  const isSuccessEvent = ['successful', 'success', 'payment.success', 'transaction.successful', 'cryptocollection.success', 'fiatcollection.success', 'paid'].includes(eventName)
    || ['successful', 'success', 'paid', 'completed'].includes(String(transactionData?.status || '').toLowerCase());

  if (!isSuccessEvent) {
    // Acknowledge non-payment events
    return res.status(200).json({ status: 'ignored', message: 'Event acknowledged' });
  }

  const reference = transactionData?.reference || transactionData?.tx_ref;
  if (!reference) {
    return res.status(200).json({ status: 'ignored', message: 'Missing transaction reference' });
  }

  try {
    // Authoritatively re-verify with IvoryPay API
    const verification = await verifyIvoryPayTransaction(reference);
    if (!verification.isVerified || !verification.transaction) {
      await logPaymentEvent('ivorypay_webhook.verification_failed', {
        reference,
        status: verification.status,
      });
      return res.status(200).json({ status: 'unverified', message: 'Transaction could not be verified' });
    }

    const verifiedTx = verification.transaction;
    const paymentValidation = validateIvoryPayTransaction(verifiedTx, reference);
    if (!paymentValidation.ok) {
      return res.status(200).json({ status: 'invalid', message: paymentValidation.message });
    }

    const paymentContext = extractIvoryPayPaymentContext(verifiedTx, { reference });
    if (!paymentContext.userId || !paymentContext.packageId) {
      await logErrorEvent('ivorypay_webhook.missing_context', {
        reference,
        hasUserId: Boolean(paymentContext.userId),
        hasPackageId: Boolean(paymentContext.packageId),
      });
      return res.status(200).json({ status: 'missing_context' });
    }

    const result = await applyVerifiedIvoryPayPayment({
      reference: paymentValidation.reference,
      userId: paymentContext.userId,
      packageId: paymentContext.packageId,
      transactionId: verifiedTx.id || verifiedTx.reference || reference,
      amountPaidNGN: paymentValidation.amountPaidNGN,
      gatewayFeeNGN: Number(verifiedTx.platformFeeInFiat || verifiedTx.fee || 0),
    });

    return res.status(200).json({
      status: 'success',
      transactionId: result.transactionId,
      creditsAdded: result.creditsAdded,
      duplicate: result.duplicate,
    });
  } catch (error) {
    await logErrorEvent('ivorypay_webhook.error', {
      error: error?.message || String(error),
      stack: error?.stack,
      reference,
    });

    return res.status(500).json({ error: 'Internal processing error' });
  }
}
