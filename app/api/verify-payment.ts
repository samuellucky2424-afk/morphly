// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import {
  applyVerifiedFlutterwavePayment,
  extractFlutterwavePaymentContext,
  validateFlutterwaveTransaction,
  verifyFlutterwaveTransaction
} from './flutterwave-payment.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const { reference, transactionId, userId, credits, priceUSD } = req.body;
  if (!reference || !transactionId || !userId) {
    return res.status(400).json({ status: 'failed', message: 'Missing reference, transactionId, or userId' });
  }

  try {
    const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!flutterwaveSecretKey) {
      return res.status(500).json({ status: 'failed', message: 'Missing Flutterwave Secret Key' });
    }

    const verification = await verifyFlutterwaveTransaction(transactionId, flutterwaveSecretKey);

    if (!verification.isVerified) {
      return res.status(400).json({ status: 'failed', message: verification.data?.message || 'Payment verification failed' });
    }

    const paymentContext = extractFlutterwavePaymentContext(verification.transaction, { reference, userId, credits, priceUSD });
    if (!paymentContext.userId) {
      return res.status(400).json({ status: 'failed', message: 'Missing payment userId metadata' });
    }

    const validation = validateFlutterwaveTransaction(verification.transaction, paymentContext.reference);
    if (!validation.ok) {
      return res.status(400).json({ status: 'failed', message: validation.message });
    }

    const result = await applyVerifiedFlutterwavePayment({
      reference: validation.reference,
      userId: paymentContext.userId,
      credits: paymentContext.credits,
      amountPaidNGN: validation.amountPaidNGN
    });

    res.json({ ...result, data: verification.transaction });
  } catch (error) {
    res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}
