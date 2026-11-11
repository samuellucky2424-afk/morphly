// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { sandboxPayments, verifySandboxPayment } from '../firebase-sandbox-payment.js';
import { logErrorEvent, logPaymentEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import {
  applyVerifiedFlutterwavePayment,
  extractFlutterwavePaymentContext,
  validateFlutterwaveTransaction,
  verifyFlutterwaveTransaction,
  verifyFlutterwaveTransactionByReference,
} from '../flutterwave-payment.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import { firebaseDb } from '../firebase-admin.js';
import { settleCheckout } from '../payment-checkouts.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const { reference, transactionId, userId, credits, packageId, priceUSD } = req.body || {};
  await logRequestEvent('verify-payment.request', {
    method: req.method,
    path: '/api/verify-payment',
    reference,
    transactionId,
    userId,
    credits,
    packageId,
    priceUSD,
  });

  if (!reference || !userId) {
    return res.status(400).json({ status: 'failed', message: 'Missing reference or userId' });
  }

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ status: 'failed', message: authResult.error });
    if (authResult.user.id !== userId) return res.status(403).json({ status: 'failed', message: 'User mismatch' });
    if (sandboxPayments()) return res.json(await verifySandboxPayment({reference,transactionId,userId}));
    const { data: profile } = await supabaseAdmin.from('users').select('account_status').eq('id', userId).maybeSingle();
    if (profile?.account_status === 'suspended') return res.status(403).json({ status: 'failed', message: 'Account suspended' });
    const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!flutterwaveSecretKey) {
      return res.status(500).json({ status: 'failed', message: 'Missing Flutterwave Secret Key' });
    }

    // Checkouts created by this server are settled from their stored record,
    // so the client's userId, packageId and amount are never trusted.
    if (firebaseDb) {
      const checkout = await settleCheckout(firebaseDb, reference, {
        secretKey: flutterwaveSecretKey,
        transactionId: transactionId || null,
        expectedUserId: userId,
      });
      if (checkout) {
        if (checkout.state === 'credited') {
          return res.json({
            status: 'success',
            duplicate: Boolean(checkout.duplicate),
            message: checkout.duplicate ? 'Payment already credited' : 'Payment verified and credits applied',
            transactionId: checkout.transactionId,
            creditsAdded: checkout.creditsAdded,
            newCredits: checkout.newCredits,
          });
        }
        if (checkout.state === 'pending') {
          return res.status(202).json({
            status: 'pending',
            message: 'Your payment is still being confirmed. Credits are added automatically once it clears.',
          });
        }
        return res.status(400).json({ status: 'failed', message: checkout.message });
      }
    }

    return res.status(400).json({ status: 'failed', message: 'Payment checkout was not created by Morphly' });
  } catch (error) {
    await logErrorEvent('verify-payment.exception', error, {
      reference,
      transactionId,
      userId,
    });
    res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}
