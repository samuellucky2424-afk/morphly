// @ts-nocheck
import { supabaseAdmin } from './supabase-admin.js';
import { tryDeliverCustomerEmails } from './customer-engagement.js';
import { logPaymentEvent } from '../../shared/backend-logger.js';
import { ensureUserWallet } from '../../shared/ensure-user-wallet.js';

const FLUTTERWAVE_API_BASE_URL = 'https://api.flutterwave.com/v3';

export const FLUTTERWAVE_MAIN_SHARE = 0.60;
export const FLUTTERWAVE_SAVINGS_SHARE = 0.40;
export const FLUTTERWAVE_CHECKOUT_DURATION_MINUTES = 30;

function createFlutterwaveConfigurationError(message) {
  const error = new Error(message);
  error.code = 'FLUTTERWAVE_CONFIGURATION_ERROR';
  return error;
}

export function isFlutterwaveTestKey(value) {
  return /(?:^|_)TEST(?:-|_)/i.test(String(value || '').trim());
}

export function isProductionPaymentEnvironment() {
  const configuredMode = String(
    process.env.FLUTTERWAVE_MODE
      || process.env.PAYMENT_ENVIRONMENT
      || '',
  ).trim().toLowerCase();

  if (configuredMode) {
    return ['live', 'production', 'prod'].includes(configuredMode);
  }

  return process.env.NODE_ENV === 'production';
}

export function validateFlutterwaveEnvironment(secretKey) {
  if (isProductionPaymentEnvironment() && isFlutterwaveTestKey(secretKey)) {
    return {
      ok: false,
      message: 'Test-mode Flutterwave transactions are disabled in production',
    };
  }

  return { ok: true };
}

export function buildFlutterwaveStandardPaymentPayload({
  userId,
  email,
  customerName,
  amountNGN,
  credits,
  packageId,
  priceUSD,
  reference,
  redirectUrl,
  linkExpiration,
  savingsSubaccountId,
}) {
  const normalizedSubaccountId = String(savingsSubaccountId || '').trim().replace(/^["']|["']$/g, '');
  if (!normalizedSubaccountId) {
    throw createFlutterwaveConfigurationError(
      'FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID is not configured; refusing to create an unsplit Flutterwave payment',
    );
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedReference = String(reference || '').trim();
  const normalizedPackageId = String(packageId || '').trim();
  const normalizedUserId = String(userId || '').trim();
  const normalizedAmount = Number(amountNGN);
  const normalizedCredits = Number(credits);

  if (!normalizedEmail || !normalizedReference || !normalizedPackageId || !normalizedUserId) {
    throw new Error('Missing required Flutterwave payment details');
  }
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('A positive Naira amount is required for a Flutterwave payment');
  }
  if (!Number.isFinite(normalizedCredits) || normalizedCredits <= 0) {
    throw new Error('A positive credit package is required for a Flutterwave payment');
  }

  let parsedRedirectUrl;
  try {
    parsedRedirectUrl = new URL(String(redirectUrl || ''));
  } catch {
    throw new Error('A valid Flutterwave redirect URL is required');
  }
  if (!['http:', 'https:'].includes(parsedRedirectUrl.protocol)) {
    throw new Error('Flutterwave redirect URL must use HTTP or HTTPS');
  }

  const parsedLinkExpiration = new Date(String(linkExpiration || ''));
  if (!Number.isFinite(parsedLinkExpiration.getTime())) {
    throw new Error('A valid Flutterwave checkout expiration is required');
  }

  const metadata = {
    userId: normalizedUserId,
    credits: normalizedCredits,
    packageId: normalizedPackageId,
  };
  const normalizedPriceUSD = Number(priceUSD);
  if (Number.isFinite(normalizedPriceUSD) && normalizedPriceUSD > 0) {
    metadata.priceUSD = normalizedPriceUSD;
  }

  return {
    tx_ref: normalizedReference,
    amount: normalizedAmount,
    currency: 'NGN',
    redirect_url: parsedRedirectUrl.toString(),
    link_expiration: parsedLinkExpiration.toISOString(),
    payment_options: 'card,banktransfer,ussd',
    customer: {
      email: normalizedEmail,
      name: String(customerName || normalizedEmail.split('@')[0] || 'Morphly User').trim(),
    },
    meta: metadata,
    customizations: {
      title: 'Morphly Credits',
      description: `Purchase ${normalizedCredits} credits`,
    },
    subaccounts: [
      {
        id: normalizedSubaccountId,
        // Flutterwave defines this percentage as the main merchant's share.
        // The savings subaccount receives the remaining 40% before deductions.
        transaction_charge_type: 'percentage',
        transaction_charge: FLUTTERWAVE_MAIN_SHARE,
      },
    ],
  };
}

export async function initiateFlutterwavePayment({
  userId,
  email,
  customerName,
  amountNGN,
  credits,
  packageId,
  priceUSD,
  reference,
  redirectUrl,
  linkExpiration,
  secretKey,
  savingsSubaccountId,
}) {
  const effectiveSecretKey = String(secretKey || process.env.FLUTTERWAVE_SECRET_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!effectiveSecretKey) {
    throw createFlutterwaveConfigurationError('FLUTTERWAVE_SECRET_KEY is not configured in server environment');
  }

  const environmentValidation = validateFlutterwaveEnvironment(effectiveSecretKey);
  if (!environmentValidation.ok) {
    throw createFlutterwaveConfigurationError(environmentValidation.message);
  }

  const payload = buildFlutterwaveStandardPaymentPayload({
    userId,
    email,
    customerName,
    amountNGN,
    credits,
    packageId,
    priceUSD,
    reference,
    redirectUrl,
    linkExpiration: linkExpiration || new Date(
      Date.now() + FLUTTERWAVE_CHECKOUT_DURATION_MINUTES * 60 * 1000,
    ).toISOString(),
    savingsSubaccountId: savingsSubaccountId || process.env.FLUTTERWAVE_SAVINGS_SUBACCOUNT_ID,
  });

  const response = await fetch(`${FLUTTERWAVE_API_BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${effectiveSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  const checkoutUrl = data?.data?.link;

  if (!response.ok || data?.status !== 'success' || !checkoutUrl) {
    const error = new Error('Flutterwave rejected the payment creation request');
    error.code = 'FLUTTERWAVE_PAYMENT_CREATION_FAILED';
    error.providerStatus = response.status;
    throw error;
  }

  return {
    status: 'success',
    reference: String(reference),
    checkoutUrl: String(checkoutUrl),
  };
}

export async function verifyFlutterwaveTransaction(transactionId, secretKey) {
  const environmentValidation = validateFlutterwaveEnvironment(secretKey);
  if (!environmentValidation.ok) {
    return {
      response: null,
      data: { status: 'error', message: environmentValidation.message },
      transaction: null,
      isVerified: false,
      environmentRejected: true,
    };
  }

  const response = await fetch(`${FLUTTERWAVE_API_BASE_URL}/transactions/${encodeURIComponent(String(transactionId))}/verify`, {
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

export async function verifyFlutterwaveTransactionByReference(reference, secretKey) {
  const environmentValidation = validateFlutterwaveEnvironment(secretKey);
  if (!environmentValidation.ok) {
    return {
      response: null,
      data: { status: 'error', message: environmentValidation.message },
      transaction: null,
      isVerified: false,
      environmentRejected: true,
    };
  }

  const response = await fetch(
    `${FLUTTERWAVE_API_BASE_URL}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(String(reference))}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
    },
  );
  const data = await response.json();
  const transaction = data?.data;
  const status = String(transaction?.status || '').toLowerCase();

  return {
    response,
    data,
    transaction,
    isVerified: response.ok && data?.status === 'success' && (status === 'successful' || status === 'succeeded'),
  };
}

export function extractFlutterwavePaymentContext(transaction, fallback = {}) {
  let meta = transaction?.meta && typeof transaction.meta === 'object' ? transaction.meta : {};

  // Flutterwave v3 can return meta as an array of {metaname, metavalue} objects.
  // Normalize it to a plain object so property reads work correctly.
  if (Array.isArray(meta)) {
    const normalized = {};
    for (const entry of meta) {
      if (entry && typeof entry === 'object' && entry.metaname) {
        normalized[entry.metaname] = entry.metavalue;
      }
    }
    meta = normalized;
  }

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

  const metaPackageId = meta.packageId || meta.package_id || null;
  const fallbackPackageId = fallback.packageId || null;
  if (metaPackageId && fallbackPackageId && metaPackageId !== fallbackPackageId) {
    throw new Error('Payment package mismatch');
  }

  const packageId = metaPackageId || fallbackPackageId;

  if (!userId) {
    console.warn('[payment] extractFlutterwavePaymentContext: userId is missing', {
      metaKeys: Object.keys(meta), hasFallbackUserId: Boolean(fallbackUserId),
      transactionId: transaction?.id, txRef: transaction?.tx_ref,
    });
  }
  if (!packageId) {
    console.warn('[payment] extractFlutterwavePaymentContext: packageId is missing', {
      metaKeys: Object.keys(meta), hasFallbackPackageId: Boolean(fallbackPackageId),
      transactionId: transaction?.id, txRef: transaction?.tx_ref,
    });
  }

  return { reference, userId, credits, packageId };
}

export function validateFlutterwaveTransaction(transaction, expectedReference) {
  const reference = transaction?.tx_ref || transaction?.reference || null;
  if (expectedReference && reference && reference !== expectedReference) {
    return { ok: false, message: 'Payment reference mismatch' };
  }

  if (transaction?.currency && transaction.currency.toUpperCase() !== 'NGN') {
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
  let { data: profile, error: profileError } = await supabaseAdmin.from('users').select('account_status').eq('id', userId).maybeSingle();
  if (profileError) throw profileError;

  if (!profile) {
    const { data: authRecord, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (authError) throw authError;
    if (!authRecord?.user) throw new Error('Payment user not found');
    await ensureUserWallet(supabaseAdmin, authRecord.user);

    const profileResult = await supabaseAdmin.from('users').select('account_status').eq('id', userId).maybeSingle();
    if (profileResult.error) throw profileResult.error;
    profile = profileResult.data;
  }

  if (profile?.account_status === 'suspended') throw new Error('Account suspended');

  const { data, error } = await supabaseAdmin.rpc('apply_verified_package_payment', {
    p_user: userId, p_package: packageId, p_reference: reference,
    p_gateway_id: String(transactionId), p_amount: amountPaidNGN, p_fee: gatewayFeeNGN,
  });
  if (error && error.code !== '23505') throw error;

  let normalizedData = error?.code === '23505'
    ? { status: 'success', duplicate: true }
    : (data || {});
  if (normalizedData.duplicate && (normalizedData.newCredits == null || normalizedData.creditsAdded == null)) {
    let transactionQuery = supabaseAdmin.from('transactions')
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
    };
  }

  await logPaymentEvent('payment.credits_applied', {
    reference,
    userId,
    amountPaidNGN,
    creditsAdded: normalizedData.creditsAdded || 0,
    newCredits: normalizedData.newCredits,
    duplicate: Boolean(normalizedData.duplicate),
  });

  await tryDeliverCustomerEmails(supabaseAdmin, { userId, sourceId: normalizedData.transactionId || null });
  return {
    status: 'success',
    message: normalizedData.duplicate ? 'Payment already processed' : 'Payment verified and credits applied',
    ...normalizedData,
  };
}
