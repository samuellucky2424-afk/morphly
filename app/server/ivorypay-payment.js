// @ts-nocheck
import crypto from 'crypto';
import { supabaseAdmin } from './supabase-admin.js';
import { logPaymentEvent } from '../../shared/backend-logger.js';
import { ensureUserWallet } from '../../shared/ensure-user-wallet.js';

const IVORYPAY_API_BASE_URL = process.env.IVORYPAY_API_BASE_URL || 'https://api.ivorypay.io/api';

export function isIvoryPayTestKey(value) {
  return /(?:^|_)test(?:-|_|$)/i.test(String(value || '').trim());
}

export function isProductionPaymentEnvironment() {
  const configuredMode = String(
    process.env.IVORYPAY_MODE
      || process.env.PAYMENT_ENVIRONMENT
      || '',
  ).trim().toLowerCase();

  if (configuredMode) {
    return ['live', 'production', 'prod'].includes(configuredMode);
  }

  return process.env.NODE_ENV === 'production';
}

export function validateIvoryPayEnvironment(secretKey) {
  if (isProductionPaymentEnvironment() && isIvoryPayTestKey(secretKey)) {
    return {
      ok: false,
      message: 'Test-mode IvoryPay transactions are disabled in production',
    };
  }

  return { ok: true };
}

export async function initiateIvoryPayTransaction({
  userId,
  email,
  amountUSD,
  priceNGN,
  credits,
  packageId,
  reference,
  redirectUrl,
  secretKey,
}) {
  const effectiveSecretKey = (secretKey || process.env.IVORYPAY_SECRET_KEY || '').trim();
  if (!effectiveSecretKey) {
    throw new Error('IVORYPAY_SECRET_KEY is not configured');
  }

  const environmentValidation = validateIvoryPayEnvironment(effectiveSecretKey);
  if (!environmentValidation.ok) {
    throw new Error(environmentValidation.message);
  }

  const effectiveReference = String(reference || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const normalizedEmail = String(email || 'user@morphly.app').trim().toLowerCase();
  const numUSD = Number(Number(amountUSD).toFixed(2));
  const numNGN = Number(priceNGN || Math.round(numUSD * 1500));

  const authHeader = effectiveSecretKey.startsWith('Bearer ') ? effectiveSecretKey : effectiveSecretKey;
  const headers = {
    Authorization: authHeader,
    'x-api-key': effectiveSecretKey.replace(/^Bearer\s+/i, ''),
    'Content-Type': 'application/json',
  };

  // Attempt strategies in sequence (USD USDT -> NGN USDT -> USD USDC -> NGN USDC)
  const strategies = [
    { baseFiat: 'USD', crypto: 'USDT', amount: numUSD, email: normalizedEmail, reference: effectiveReference },
    { baseFiat: 'NGN', crypto: 'USDT', amount: numNGN, email: normalizedEmail, reference: effectiveReference },
    { baseFiat: 'USD', crypto: 'USDC', amount: numUSD, email: normalizedEmail, reference: effectiveReference },
    { baseFiat: 'NGN', crypto: 'USDC', amount: numNGN, email: normalizedEmail, reference: effectiveReference },
  ];

  let lastError = null;
  let successData = null;

  for (const strategy of strategies) {
    try {
      const response = await fetch(`${IVORYPAY_API_BASE_URL}/v1/transactions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...strategy,
          ...(redirectUrl ? { redirectUrl } : {}),
          metadata: {
            userId: String(userId),
            packageId: String(packageId),
            credits: Number(credits),
            priceUSD: numUSD,
            priceNGN: numNGN,
          },
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok && (data?.status === true || data?.data || data?.checkoutUrl || data?.link)) {
        successData = data;
        break;
      }

      lastError = data?.message || data?.error || `HTTP ${response.status}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
  }

  if (!successData) {
    throw new Error(lastError || 'IvoryPay payment initiation failed');
  }

  const checkoutUrl = successData?.data?.checkoutUrl
    || successData?.data?.link
    || successData?.data?.url
    || successData?.data?.paymentLink
    || successData?.checkoutUrl
    || successData?.link
    || successData?.paymentLink;

  return {
    status: 'success',
    reference: effectiveReference,
    checkoutUrl,
    data: successData?.data || successData,
  };
}

export async function verifyIvoryPayTransaction(reference, secretKey) {
  const effectiveSecretKey = secretKey || process.env.IVORYPAY_SECRET_KEY;
  if (!effectiveSecretKey) {
    return {
      response: null,
      data: { status: 'error', message: 'IVORYPAY_SECRET_KEY is not configured' },
      transaction: null,
      isVerified: false,
    };
  }

  const environmentValidation = validateIvoryPayEnvironment(effectiveSecretKey);
  if (!environmentValidation.ok) {
    return {
      response: null,
      data: { status: 'error', message: environmentValidation.message },
      transaction: null,
      isVerified: false,
      environmentRejected: true,
    };
  }

  // Try standard reference lookup endpoint first
  let response = await fetch(`${IVORYPAY_API_BASE_URL}/v1/transactions/${encodeURIComponent(String(reference))}`, {
    method: 'GET',
    headers: {
      Authorization: effectiveSecretKey,
      'Content-Type': 'application/json',
    },
  });

  // Fallback to /verify/:reference if needed
  if (response.status === 404) {
    response = await fetch(`${IVORYPAY_API_BASE_URL}/v1/transactions/verify/${encodeURIComponent(String(reference))}`, {
      method: 'GET',
      headers: {
        Authorization: effectiveSecretKey,
        'Content-Type': 'application/json',
      },
    });
  }

  const data = await response.json().catch(() => ({}));
  const transaction = data?.data || data?.transaction || data;
  const status = String(transaction?.status || data?.status || '').toLowerCase();

  const isSuccessful = ['success', 'successful', 'succeeded', 'paid', 'completed'].includes(status);

  return {
    response,
    data,
    transaction,
    isVerified: response.ok && isSuccessful,
    status,
  };
}

export function extractIvoryPayPaymentContext(transaction, fallback = {}) {
  const meta = transaction?.metadata && typeof transaction.metadata === 'object'
    ? transaction.metadata
    : (transaction?.meta && typeof transaction.meta === 'object' ? transaction.meta : {});

  const reference = transaction?.reference || transaction?.tx_ref || fallback.reference || null;

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

  const metaPackageId = meta.packageId || meta.package_id || null;
  const fallbackPackageId = fallback.packageId || null;
  if (metaPackageId && fallbackPackageId && metaPackageId !== fallbackPackageId) {
    throw new Error('Payment package mismatch');
  }

  const packageId = metaPackageId || fallbackPackageId;

  return { reference, userId, credits, packageId };
}

export function validateIvoryPayTransaction(transaction, expectedReference) {
  const reference = transaction?.reference || transaction?.tx_ref || null;
  if (expectedReference && reference && reference !== expectedReference) {
    return { ok: false, message: 'Payment reference mismatch' };
  }

  const amountPaid = Number(transaction?.amount || transaction?.amountPaid || 0);
  if (!(amountPaid > 0)) {
    return { ok: false, message: 'Invalid verified crypto amount' };
  }

  return { ok: true, reference: reference || expectedReference, amountPaidUSD: amountPaid };
}

export async function applyVerifiedIvoryPayPayment({
  reference,
  userId,
  packageId,
  transactionId,
  amountPaidUSD,
  gatewayFeeUSD = 0,
}) {
  if (!reference || !userId || !packageId || !transactionId) {
    throw new Error('Missing verified crypto payment context');
  }

  let { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('account_status')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) throw profileError;

  if (!profile) {
    const { data: authRecord, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (authError) throw authError;
    if (!authRecord?.user) throw new Error('Payment user not found');
    await ensureUserWallet(supabaseAdmin, authRecord.user);

    const profileResult = await supabaseAdmin
      .from('users')
      .select('account_status')
      .eq('id', userId)
      .maybeSingle();
    if (profileResult.error) throw profileResult.error;
    profile = profileResult.data;
  }

  if (profile?.account_status === 'suspended') {
    throw new Error('Account suspended');
  }

  const { data, error } = await supabaseAdmin.rpc('apply_verified_package_payment', {
    p_user: userId,
    p_package: packageId,
    p_reference: reference,
    p_gateway_id: String(transactionId),
    p_amount: amountPaidUSD,
    p_fee: gatewayFeeUSD,
  });

  if (error && error.code !== '23505') throw error;

  let normalizedData = error?.code === '23505'
    ? { status: 'success', duplicate: true }
    : (data || {});

  if (normalizedData.duplicate && (normalizedData.newCredits == null || normalizedData.creditsAdded == null)) {
    let transactionQuery = supabaseAdmin
      .from('transactions')
      .select('id, user_id, credits, package_credits_snapshot');
    transactionQuery = normalizedData.transactionId
      ? transactionQuery.eq('id', normalizedData.transactionId)
      : transactionQuery.eq('reference', reference);

    const [walletResult, transactionResult] = await Promise.all([
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
      transactionQuery.limit(1).maybeSingle(),
    ]);

    if (walletResult.error) throw walletResult.error;
    if (transactionResult.error) throw transactionResult.error;
    if (transactionResult.data?.user_id && transactionResult.data.user_id !== userId) {
      throw new Error('Payment user mismatch');
    }

    normalizedData = {
      ...normalizedData,
      transactionId: normalizedData.transactionId || transactionResult.data?.id,
      creditsAdded: Number(transactionResult.data?.package_credits_snapshot ?? transactionResult.data?.credits ?? 0),
      newCredits: Number(walletResult.data?.credits ?? 0),
      firstPurchaseRewardGranted: false,
    };
  }

  await logPaymentEvent('ivorypay_payment.applied', {
    userId,
    reference,
    transactionId,
    packageId,
    amountUSD: amountPaidUSD,
    duplicate: Boolean(normalizedData.duplicate),
    creditsAdded: normalizedData.creditsAdded,
    newCredits: normalizedData.newCredits,
    firstPurchaseRewardGranted: Boolean(normalizedData.firstPurchaseRewardGranted),
  });

  return normalizedData;
}

export function hasValidIvoryPaySignature(rawBody, signature, secret) {
  if (!signature || !secret || !rawBody) return false;

  const hexSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const base64Signature = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  const incomingSig = String(signature).trim();

  // Support hex or base64 signature formats
  if (incomingSig.length === hexSignature.length) {
    try {
      return crypto.timingSafeEqual(Buffer.from(hexSignature), Buffer.from(incomingSig));
    } catch {
      return false;
    }
  }

  if (incomingSig.length === base64Signature.length) {
    try {
      return crypto.timingSafeEqual(Buffer.from(base64Signature), Buffer.from(incomingSig));
    } catch {
      return false;
    }
  }

  return incomingSig === secret;
}
