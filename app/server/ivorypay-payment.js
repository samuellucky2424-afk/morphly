// @ts-nocheck
import crypto from 'crypto';
import { supabaseAdmin } from './supabase-admin.js';
import { logPaymentEvent } from '../../shared/backend-logger.js';
import { ensureUserWallet } from '../../shared/ensure-user-wallet.js';

const IVORYPAY_API_BASE_URL = String(
  process.env.IVORYPAY_API_BASE_URL || 'https://api.ivorypay.io/api',
).replace(/\/+$/, '').replace(/\/v1$/, '');

function getProviderErrorMessage(data, status) {
  const message = data?.message || data?.error || data?.errors?.[0]?.message;
  return message ? String(message) : `HTTP ${status}`;
}

function getIvoryPayCryptoChain() {
  return String(process.env.IVORYPAY_CRYPTO_CHAIN || 'BSC_MAINNET').trim().toUpperCase();
}

function getIvoryPayCryptoToken() {
  return String(process.env.IVORYPAY_CRYPTO_TOKEN || 'USDT').trim().toUpperCase();
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

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
  if (process.env.IVORYPAY_ALLOW_TEST === 'true' || process.env.IVORYPAY_MODE === 'test') {
    return { ok: true };
  }

  if (isProductionPaymentEnvironment() && process.env.IVORYPAY_BLOCK_TEST_KEYS === 'true' && isIvoryPayTestKey(secretKey)) {
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
  secretKey,
}) {
  const effectiveSecretKey = (secretKey || process.env.IVORYPAY_SECRET_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!effectiveSecretKey) {
    throw new Error('IVORYPAY_SECRET_KEY is not configured in server environment');
  }

  const environmentValidation = validateIvoryPayEnvironment(effectiveSecretKey);
  if (!environmentValidation.ok) {
    throw new Error(environmentValidation.message);
  }

  const effectiveReference = String(reference || '').trim();
  if (!crypto.randomUUID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(effectiveReference)) {
    throw new Error('IvoryPay requires a UUID payment reference');
  }

  const normalizedEmail = String(email || 'user@morphly.app').trim().toLowerCase();
  const numUSD = Number(Number(amountUSD).toFixed(2));
  const numNGN = Number(priceNGN || Math.round(numUSD * 1500));
  if (!Number.isFinite(numNGN) || numNGN <= 0) {
    throw new Error('A positive Naira amount is required for an IvoryPay payment');
  }

  const firstName = normalizedEmail.split('@')[0].split(/[._-]/)[0] || 'Morphly';
  const lastName = 'User';

  const headers = {
    Authorization: effectiveSecretKey,
    'Content-Type': 'application/json',
  };

  // IvoryPay's API flow provides the wallet address and amount to show in our UI;
  // it does not return a hosted checkout link for an API-mode crypto collection.
  const payload = {
    amount: numNGN,
    type: 'CRYPTO',
    chain: getIvoryPayCryptoChain(),
    firstName,
    lastName,
    email: normalizedEmail,
    reference: effectiveReference,
    baseFiat: 'NGN',
    mode: 'API',
    crypto: getIvoryPayCryptoToken(),
    metadata: JSON.stringify({
      userId: String(userId),
      packageId: String(packageId),
      credits: Number(credits),
      priceUSD: numUSD,
      priceNGN: numNGN,
    }),
  };

  const response = await fetch(`${IVORYPAY_API_BASE_URL}/v1/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const successData = await response.json().catch(() => ({}));

  if (!response.ok || successData?.status === false || !successData?.data) {
    throw new Error(`IvoryPay rejected the payment request: ${getProviderErrorMessage(successData, response.status)}`);
  }

  const transaction = successData.data;
  const collectionDetails = transaction.collectionDetails || {};
  if (!collectionDetails.address || !transaction.amountInCrypto) {
    throw new Error('IvoryPay did not return crypto payment instructions');
  }

  const checkoutUrl = transaction.checkoutUrl
    || transaction.link
    || transaction.url
    || transaction.paymentLink;

  return {
    status: 'success',
    reference: effectiveReference,
    checkoutUrl,
    paymentInstructions: {
      address: collectionDetails.address,
      chain: collectionDetails.network || payload.chain,
      amount: transaction.amountInCrypto,
      currency: transaction.currency || payload.crypto,
      expiresAt: transaction.expiresAt || null,
    },
    data: transaction,
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

  // This is IvoryPay's documented status endpoint. It is public, but the
  // server—not the browser—calls it before crediting a wallet.
  const response = await fetch(
    `${IVORYPAY_API_BASE_URL}/v1/transactions/${encodeURIComponent(String(reference))}/verify`,
    { method: 'GET' },
  );

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
  const meta = parseMetadata(transaction?.metadata || transaction?.meta);

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

  // The package amount is stored in NGN, so only accept IvoryPay's fiat/base
  // amount here—not the on-chain token amount.
  const amountPaid = Number(
    transaction?.amountInBaseFiat
      || transaction?.amountInFiat
      || transaction?.amount
      || transaction?.amountPaid
      || 0,
  );
  if (!(amountPaid > 0)) {
    return { ok: false, message: 'Invalid verified crypto amount' };
  }

  return { ok: true, reference: reference || expectedReference, amountPaidNGN: amountPaid };
}

export async function applyVerifiedIvoryPayPayment({
  reference,
  userId,
  packageId,
  transactionId,
  amountPaidNGN,
  gatewayFeeNGN = 0,
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

  const { data, error } = await supabaseAdmin.rpc('apply_verified_ivorypay_payment', {
    p_user: userId,
    p_package: packageId,
    p_reference: reference,
    p_gateway_id: String(transactionId),
    p_amount: amountPaidNGN,
    p_fee: gatewayFeeNGN,
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
    amountNGN: amountPaidNGN,
    duplicate: Boolean(normalizedData.duplicate),
    creditsAdded: normalizedData.creditsAdded,
    newCredits: normalizedData.newCredits,
    firstPurchaseRewardGranted: Boolean(normalizedData.firstPurchaseRewardGranted),
  });

  return normalizedData;
}

export function hasValidIvoryPaySignature(rawBody, signature, secret, signedData = '') {
  if (!signature || !secret || !rawBody) return false;

  const incomingSig = String(signature).trim();
  const candidateSignatures = [
    // IvoryPay signs JSON.stringify(payload.data) with HMAC SHA-512.
    signedData ? crypto.createHmac('sha512', secret).update(signedData).digest('hex') : '',
    // Support the historic full-body SHA-256 variants while old webhooks drain.
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
    crypto.createHmac('sha256', secret).update(rawBody).digest('base64'),
  ].filter(Boolean);

  return candidateSignatures.some((expectedSignature) => {
    if (incomingSig.length !== expectedSignature.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(incomingSig));
    } catch {
      return false;
    }
  });
}
