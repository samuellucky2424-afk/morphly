// @ts-nocheck
import { supabaseAdmin } from './supabase-admin.js';
import { logPaymentEvent } from '../../shared/backend-logger.js';

export async function verifyFlutterwaveTransaction(transactionId, secretKey) {
  const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(String(transactionId))}/verify`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  const transaction = data?.data;
  const status = String(transaction?.status || '').toLowerCase();

  return {
    response,
    data,
    transaction,
    isVerified: response.ok && data?.status === 'success' && (status === 'successful' || status === 'succeeded')
  };
}

export function extractFlutterwavePaymentContext(transaction, fallback = {}) {
  const meta = transaction?.meta && typeof transaction.meta === 'object' ? transaction.meta : {};
  const reference = transaction?.tx_ref || transaction?.reference || fallback.reference || null;

  const metaUserId = meta.userId || meta.user_id || null;
  const fallbackUserId = fallback.userId || null;
  if (metaUserId && fallbackUserId && metaUserId !== fallbackUserId) {
    throw new Error('Payment user mismatch');
  }

  const userId = metaUserId || fallbackUserId;

  const metaCredits = Number(meta.credits);
  const fallbackCredits = Number(fallback.credits);
  if (
    Number.isFinite(metaCredits) &&
    metaCredits > 0 &&
    Number.isFinite(fallbackCredits) &&
    fallbackCredits > 0 &&
    metaCredits !== fallbackCredits
  ) {
    throw new Error('Payment credits mismatch');
  }

  const credits = Number.isFinite(metaCredits) && metaCredits > 0
    ? metaCredits
    : (Number.isFinite(fallbackCredits) && fallbackCredits > 0 ? fallbackCredits : null);

  const packageId = meta.packageId || meta.package_id || fallback.packageId || null;
  return { reference, userId, credits, packageId };
}

export function validateFlutterwaveTransaction(transaction, expectedReference) {
  const reference = transaction?.tx_ref || transaction?.reference || null;
  if (expectedReference && reference && reference !== expectedReference) {
    return { ok: false, message: 'Payment reference mismatch' };
  }

  if (transaction?.currency && transaction.currency !== 'NGN') {
    return { ok: false, message: 'Unexpected payment currency' };
  }

  const amountPaidNGN = Number(transaction?.amount || 0);
  if (!(amountPaidNGN > 0)) {
    return { ok: false, message: 'Invalid verified amount' };
  }

  return { ok: true, reference: reference || expectedReference, amountPaidNGN };
}

export async function applyVerifiedFlutterwavePayment({ reference, userId, packageId, transactionId, amountPaidNGN, gatewayFeeNGN = 0 }) {
  if (!reference || !userId || !packageId || !transactionId) {
    throw new Error('Missing verified payment context');
  }
  const { data: profile, error: profileError } = await supabaseAdmin.from('users').select('account_status').eq('id', userId).maybeSingle();
  if (profileError) throw profileError;
  if (profile?.account_status === 'suspended') throw new Error('Account suspended');

  const { data, error } = await supabaseAdmin.rpc('apply_verified_package_payment', {
    p_user: userId, p_package: packageId, p_reference: reference,
    p_gateway_id: String(transactionId), p_amount: amountPaidNGN, p_fee: gatewayFeeNGN,
  });
  if (error) throw error;

  await logPaymentEvent('payment.credits_applied', {
    reference,
    userId,
    amountPaidNGN,
    creditsAdded: data?.creditsAdded || 0,
    newCredits: data?.newCredits,
    duplicate: Boolean(data?.duplicate),
  });

  return {
    status: 'success',
    message: data?.duplicate ? 'Payment already processed' : 'Payment verified by webhook',
    ...data,
  };
}
