import { hash } from './firebase-store.js';
import { createAffiliateService } from './affiliate-service.mjs';
import { nairaToKobo } from '../../shared/affiliate-program.mjs';

function logFailure(label) {
  try { console.error(`[affiliate] ${label}`); } catch { /* ignore */ }
}

async function enqueue(db, input, message) {
  const id = hash(`affiliate-reconcile:${input.gateway}:${input.gatewayId}`);
  await db.collection('affiliate_reconcile').doc(id).set({
    user_id: input.userId,
    gateway: input.gateway,
    gateway_id: String(input.gatewayId),
    reference: input.reference || null,
    transaction_id: input.transactionId || null,
    status: 'pending',
    error: String(message || 'failed').slice(0, 180),
    updated_at: new Date().toISOString(),
  }, { merge: true });
}

export async function recordCommissionAfterCredit(db, input) {
  const service = createAffiliateService(db);
  try {
    let packagePriceKobo = null;
    let transactionType = 'credit_purchase';
    let refunded = false;
    let settlementUnverified = true;
    if (input.transactionId) {
      const snap = await db.collection('transactions').doc(input.transactionId).get();
      if (snap.exists) {
        const row = snap.data();
        transactionType = row.transaction_type || row.type || 'credit_purchase';
        refunded = Boolean(row.refund_status && row.refund_status !== 'none');
        packagePriceKobo = nairaToKobo(row.package_price_snapshot_ngn);
        settlementUnverified = packagePriceKobo == null;
      }
    }
    await service.recordQualifyingPurchase({
      referredUserId: input.userId,
      paymentTxId: `${input.gateway}:${input.gatewayId}`,
      gateway: input.gateway,
      reference: input.reference,
      packagePriceKobo,
      transactionType,
      refunded,
      settlementUnverified,
      currency: 'NGN',
    });
    if (input.queueId) {
      await db.collection('affiliate_reconcile').doc(input.queueId).set({ status: 'done', updated_at: new Date().toISOString() }, { merge: true });
    }
  } catch (error) {
    logFailure('commission failed');
    try {
      await enqueue(db, input, error?.message);
    } catch {
      logFailure('reconcile enqueue failed');
    }
  }
}

export async function reconcileAffiliateCommissions(db) {
  const snap = await db.collection('affiliate_reconcile').where('status', '==', 'pending').get();
  let retried = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const row = doc.data();
    const before = doc.data().error;
    await recordCommissionAfterCredit(db, {
      userId: row.user_id,
      gateway: row.gateway,
      gatewayId: row.gateway_id,
      reference: row.reference,
      transactionId: row.transaction_id,
      queueId: doc.id,
    });
    const after = await doc.ref.get();
    if (after.data()?.status === 'done') retried += 1;
    else if (after.data()?.error !== before) failed += 1;
    else failed += 1;
  }
  return { examined: snap.size, retried, failed };
}
