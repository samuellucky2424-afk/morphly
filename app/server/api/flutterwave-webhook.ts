// @ts-nocheck
import crypto from 'crypto';
import { sandboxPayments, verifySandboxPayment } from '../firebase-sandbox-payment.js';
import { firebaseDb } from '../firebase-admin.js';
import { hash } from '../firebase-store.js';
import { validSignature } from '../firebase-payment-runtime.mjs';

import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { settleCheckout } from '../payment-checkouts.js';
import { logErrorEvent, logPaymentEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import {
  applyVerifiedFlutterwavePayment,
  extractFlutterwavePaymentContext,
  validateFlutterwaveTransaction,
  verifyFlutterwaveTransaction
} from '../flutterwave-payment.js';

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
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

function sameSecret(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hasValidFlutterwaveSignature(rawBody, signature, secretHash) {
  if (!signature || !secretHash) return false;
  const provided = String(signature);
  const hmac = crypto.createHmac('sha256', secretHash).update(rawBody).digest('base64');
  return sameSecret(provided, secretHash) || sameSecret(provided, hmac);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, flutterwave-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  if (sandboxPayments()) {
    const raw = await readRawBody(req);
    if (!validSignature('flutterwave',Buffer.from(raw),getHeader(req,'flutterwave-signature'),process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH)) return res.status(401).json({error:'Invalid signature'});
    try {
      const event=JSON.parse(raw);
      if ((event.type||event.event)!=='charge.completed') return res.json({received:true,ignored:true});
      const orders=await firebaseDb.collection('review_payment_orders').where('chargeId','==',event.data?.id||'').limit(2).get();
      if (orders.size!==1) return res.json({received:true,unmatched:true});
      const order=orders.docs[0].data();
      return res.json({received:true,...await verifySandboxPayment({reference:order.reference,transactionId:event.data.id,userId:order.userId})});
    } catch {return res.status(503).json({error:'Verification or fulfillment unavailable; retry'});}
  }

  const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const webhookSecretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH || process.env.FLW_SECRET_HASH;
  if (!flutterwaveSecretKey || !webhookSecretHash) {
    return res.status(500).json({ status: 'failed', message: 'Missing Flutterwave webhook configuration' });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = getHeader(req, 'flutterwave-signature') || getHeader(req, 'verif-hash');
    await logRequestEvent('flutterwave-webhook.request', {
      method: req.method,
      path: '/api/flutterwave-webhook',
      signaturePresent: Boolean(signature),
    });

    if (!hasValidFlutterwaveSignature(rawBody, signature, webhookSecretHash)) {
      await logPaymentEvent('flutterwave-webhook.invalid_signature', {
        method: req.method,
        path: '/api/flutterwave-webhook',
      });
      return res.status(401).json({ status: 'failed', message: 'Invalid webhook signature' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(rawBody || '{}');
    if (payload?.type && payload.type !== 'charge.completed') {
      await logPaymentEvent('flutterwave-webhook.ignored_type', {
        type: payload?.type,
      });
      return res.status(200).json({ received: true, ignored: true });
    }

    const webhookTransaction = payload?.data || {};
    const transactionId = webhookTransaction?.id || webhookTransaction?.transaction_id;
    const webhookStatus = String(webhookTransaction?.status || '').toLowerCase();
    if (webhookStatus && webhookStatus !== 'successful' && webhookStatus !== 'succeeded') {
      await logPaymentEvent('flutterwave-webhook.ignored_status', {
        status: webhookStatus,
        transactionId,
      });
      return res.status(200).json({ received: true, ignored: true });
    }

    if (!transactionId) {
      return res.status(400).json({ status: 'failed', message: 'Missing webhook transaction ID' });
    }

    const verification = await verifyFlutterwaveTransaction(transactionId, flutterwaveSecretKey);
    if (!verification.isVerified) {
      return res.status(400).json({ status: 'failed', message: verification.data?.message || 'Payment verification failed' });
    }

    const reference = verification.transaction?.tx_ref || verification.transaction?.reference;
    if (!firebaseDb || !reference) {
      return res.status(400).json({ status: 'failed', message: 'Payment checkout was not created by Morphly' });
    }
    const checkout = await settleCheckout(firebaseDb, reference, { secretKey: flutterwaveSecretKey, transactionId });
    if (!checkout || checkout.state !== 'credited') {
      return res.status(checkout?.state === 'pending' ? 202 : 400).json({ status: 'failed', message: checkout?.message || 'Payment checkout was not created by Morphly' });
    }
    const result = checkout;

    await logPaymentEvent('flutterwave-webhook.processed', {
      reference,
      transactionId,
      creditsAdded: result.creditsAdded,
      newCredits: result.newCredits,
      status: result.state,
    });

    return res.status(200).json({ received: true, processed: true, ...result });
  } catch (error) {
    await logErrorEvent('flutterwave-webhook.exception', error, {
      method: req.method,
      path: '/api/flutterwave-webhook',
    });
    return res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}
