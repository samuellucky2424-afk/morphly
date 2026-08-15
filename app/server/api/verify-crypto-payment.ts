// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logPaymentEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import {
  applyVerifiedIvoryPayPayment,
  extractIvoryPayPaymentContext,
  validateIvoryPayTransaction,
  verifyIvoryPayTransaction,
} from '../ivorypay-payment.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const { reference, userId, credits, packageId, priceUSD } = req.body || {};

  await logRequestEvent('verify-crypto-payment.request', {
    method: req.method,
    path: '/api/verify-crypto-payment',
    reference,
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

    const verification = await verifyIvoryPayTransaction(reference);

    if (verification.environmentRejected) {
      return res.status(400).json({ status: 'failed', message: verification.data?.message || 'Environment rejected' });
    }

    if (!verification.isVerified || !verification.transaction) {
      const isPending = ['pending', 'processing', 'initiated'].includes(String(verification.status || '').toLowerCase());
      if (isPending) {
        return res.status(202).json({
          status: 'pending',
          message: 'Crypto payment is awaiting blockchain confirmation. Credits will appear once confirmed.',
        });
      }

      await logPaymentEvent('ivorypay_payment.verification_failed', {
        reference,
        userId,
        status: verification.status,
        providerResponse: verification.data,
      });

      return res.status(400).json({
        status: 'failed',
        message: verification.data?.message || 'Crypto payment could not be verified with IvoryPay',
      });
    }

    const transaction = verification.transaction;
    const paymentValidation = validateIvoryPayTransaction(transaction, reference);
    if (!paymentValidation.ok) {
      return res.status(400).json({ status: 'failed', message: paymentValidation.message });
    }

    const paymentContext = extractIvoryPayPaymentContext(transaction, {
      reference,
      userId,
      credits,
      packageId,
    });

    const result = await applyVerifiedIvoryPayPayment({
      reference: paymentValidation.reference,
      userId: paymentContext.userId,
      packageId: paymentContext.packageId,
      transactionId: transaction.id || transaction.reference || reference,
      amountPaidNGN: paymentValidation.amountPaidNGN,
      gatewayFeeNGN: Number(transaction.platformFeeInFiat || transaction.fee || 0),
    });

    return res.status(200).json({
      status: 'success',
      transactionId: result.transactionId,
      creditsAdded: result.creditsAdded,
      newCredits: result.newCredits,
      newBalance: result.newCredits,
      duplicate: Boolean(result.duplicate),
      firstPurchaseRewardGranted: Boolean(result.firstPurchaseRewardGranted),
    });
  } catch (error) {
    await logErrorEvent('verify-crypto-payment.error', {
      error: error?.message || String(error),
      stack: error?.stack,
      reference,
      userId,
    });

    return res.status(500).json({
      status: 'failed',
      message: error?.message || 'Server error verifying crypto payment',
    });
  }
}
