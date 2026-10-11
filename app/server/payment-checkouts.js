// @ts-nocheck
// Server-side record of every Flutterwave checkout. Credits are granted from
// this record, never from client-supplied user, package or amount values.
import { hash } from './firebase-store.js';
import {
  applyVerifiedFlutterwavePayment,
  extractFlutterwavePaymentContext,
  validateFlutterwaveTransaction,
  verifyFlutterwaveTransaction,
  verifyFlutterwaveTransactionByReference,
} from './flutterwave-payment.js';
import { logErrorEvent, logPaymentEvent } from '../../shared/backend-logger.js';

// Flutterwave payment links expire after 30 minutes. Anything still unpaid
// after this window has no further payment to wait for.
export const CHECKOUT_EXPIRY_MS = 35 * 60 * 1000;
// A transaction the provider still reports as pending is retried for a day.
export const PENDING_RETRY_LIMIT_MS = 24 * 60 * 60 * 1000;
// Give the browser return flow a chance to verify before the sweep does.
export const SWEEP_MIN_AGE_MS = 5 * 60 * 1000;
const PROVIDER_FAILED_STATES = ['failed', 'cancelled', 'canceled', 'error', 'declined'];

const recordRef = (db, reference) => db.collection('payment_checkouts').doc(hash(String(reference)));

export async function createCheckoutRecord(db, { reference, userId, packageId, credits, amountNGN }) {
  const now = new Date().toISOString();
  await recordRef(db, reference).create({
    reference, userId, packageId, credits, amountNGN,
    status: 'pending', created_at: now, updated_at: now,
  });
}

export async function getCheckoutRecord(db, reference) {
  const snapshot = await recordRef(db, reference).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function updateRecord(db, reference, patch) {
  await recordRef(db, reference).set({ ...patch, updated_at: new Date().toISOString() }, { merge: true });
}

// Settles one checkout from its server-side record. Returns null when no
// record exists (checkouts created before this change), otherwise one of:
//   { state: 'credited', transactionId, creditsAdded, newCredits, duplicate }
//   { state: 'pending', providerStatus }
//   { state: 'failed', message }
export async function settleCheckout(db, reference, { secretKey, transactionId = null, expectedUserId = null }) {
  const record = await getCheckoutRecord(db, reference);
  if (!record) return null;
  if (expectedUserId && record.userId !== expectedUserId) {
    return { state: 'failed', message: 'This payment belongs to a different account.' };
  }
  if (record.status === 'credited') {
    return {
      state: 'credited', duplicate: true, transactionId: record.transactionId,
      creditsAdded: record.creditsAdded, newCredits: record.newCredits,
    };
  }

  const verification = transactionId
    ? await verifyFlutterwaveTransaction(transactionId, secretKey)
    : await verifyFlutterwaveTransactionByReference(reference, secretKey);
  const ageMs = Date.now() - Date.parse(record.created_at);

  if (!verification.isVerified) {
    const providerStatus = String(verification.transaction?.status || '').toLowerCase();
    if (PROVIDER_FAILED_STATES.includes(providerStatus)) {
      await updateRecord(db, reference, { status: 'failed', failure_reason: providerStatus });
      return { state: 'failed', message: 'Payment was not completed. No credits were added.' };
    }
    if (!providerStatus && ageMs > CHECKOUT_EXPIRY_MS) {
      await updateRecord(db, reference, { status: 'expired', failure_reason: 'no_payment_received' });
      return { state: 'failed', message: 'This checkout expired before a payment was made.' };
    }
    if (ageMs > PENDING_RETRY_LIMIT_MS) {
      await updateRecord(db, reference, { status: 'expired', failure_reason: 'still_pending_after_24h' });
      return { state: 'failed', message: 'This payment is still unconfirmed. Contact support with your reference.' };
    }
    return { state: 'pending', providerStatus };
  }

  const paymentContext = extractFlutterwavePaymentContext(verification.transaction, {
    reference,
    userId: record.userId,
    packageId: record.packageId,
    credits: record.credits,
  });
  const validation = validateFlutterwaveTransaction(verification.transaction, reference);
  if (!validation.ok) {
    await updateRecord(db, reference, { status: 'failed', failure_reason: validation.message });
    return { state: 'failed', message: validation.message };
  }

  const providerTransactionId = verification.transaction?.id || transactionId;
  const result = await applyVerifiedFlutterwavePayment({
    reference: validation.reference,
    userId: record.userId,
    packageId: paymentContext.packageId || record.packageId,
    transactionId: providerTransactionId,
    amountPaidNGN: validation.amountPaidNGN,
    gatewayFeeNGN: Number(verification.transaction?.app_fee || 0),
  });

  const credited = {
    transactionId: result.transactionId || providerTransactionId,
    creditsAdded: result.creditsAdded ?? record.credits,
    newCredits: result.newCredits,
  };
  await updateRecord(db, reference, { status: 'credited', ...credited });
  await logPaymentEvent('checkout.credited', {
    reference, userId: record.userId, duplicate: Boolean(result.duplicate), creditsAdded: credited.creditsAdded,
  });
  return { state: 'credited', duplicate: Boolean(result.duplicate), ...credited };
}

// Runs at checkout start for the user's own older pending checkouts, so a
// user who returns and buys again recovers any unconfirmed payment.
export async function settleUserPendingCheckouts(db, userId, { secretKey, max = 3 }) {
  const snapshot = await db.collection('payment_checkouts')
    .where('userId', '==', userId).where('status', '==', 'pending').limit(max).get();
  for (const doc of snapshot.docs) {
    const record = doc.data();
    if (Date.now() - Date.parse(record.created_at) < SWEEP_MIN_AGE_MS) continue;
    try {
      await settleCheckout(db, record.reference, { secretKey, expectedUserId: userId });
    } catch (error) {
      await logErrorEvent('checkout.settle_failed', error, { reference: record.reference });
    }
  }
}

// Scheduled sweep: settles pending checkouts older than the minimum age.
export async function sweepPendingCheckouts(db, { secretKey, limit = 50, now = Date.now() }) {
  const snapshot = await db.collection('payment_checkouts').where('status', '==', 'pending').limit(limit).get();
  const summary = { examined: snapshot.size, credited: 0, pending: 0, failed: 0, skippedRecent: 0, errors: 0 };
  for (const doc of snapshot.docs) {
    const record = doc.data();
    if (now - Date.parse(record.created_at) < SWEEP_MIN_AGE_MS) {
      summary.skippedRecent++;
      continue;
    }
    try {
      const outcome = await settleCheckout(db, record.reference, { secretKey });
      if (outcome?.state === 'credited') summary.credited++;
      else if (outcome?.state === 'pending') summary.pending++;
      else summary.failed++;
    } catch (error) {
      summary.errors++;
      await logErrorEvent('payment-sweep.item_failed', error, { reference: record.reference });
    }
  }
  return summary;
}
