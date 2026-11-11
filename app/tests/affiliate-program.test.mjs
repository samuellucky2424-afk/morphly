import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryFirestore } from './helpers/memory-firestore.mjs';
import { createAffiliateService } from '../server/affiliate-service.mjs';
import { createPaymentRuntime } from '../server/firebase-payment-runtime.mjs';
import { createFirebaseOperations } from '../server/firebase-operations.js';
import { createUserAffiliateHandler } from '../server/api/affiliate.js';
import { ADMIN_AFFILIATE_ACTIONS, createAdminAffiliateHandler } from '../server/api/admin-affiliates.js';
import { nairaToKobo } from '../../shared/affiliate-program.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appDirectory = path.join(root, 'app');
const PURCHASE = 12500 * 100;
const COMMISSION = 75000;

function service(clock = Date.parse('2026-11-11T10:00:00+01:00')) {
  const db = createMemoryFirestore();
  const state = { clock };
  const svc = createAffiliateService(db, { now: () => state.clock });
  return { db, svc, state, addDays(days) { state.clock += days * 86400000; } };
}

async function readyAffiliate(extra = {}) {
  const fx = service();
  await fx.db.collection('users').doc('aff_amina').set({
    id: 'aff_amina', account_status: 'active', referral_code: 'ABC123', email: 'amina@example.com', name: 'Amina Okonkwo',
  });
  await fx.svc.updateSettings('admin_samuel', { registrationsEnabled: true, ...extra }, { superAdmin: true });
  const applied = await fx.svc.apply({ userId: 'aff_amina', name: 'Amina Okonkwo', email: 'amina@example.com', acceptTerms: true });
  const approved = await fx.svc.approve('admin_samuel', 'aff_amina');
  return { ...fx, applied, approved, authTime: Math.floor(fx.state.clock / 1000) };
}

async function bank(fx) {
  await fx.svc.saveBankAccount({
    userId: 'aff_amina', bankCode: '058', accountNumber: '0123456789', accountName: 'AMINA OKONKWO', authTime: Math.floor(fx.state.clock / 1000),
  });
  const banks = await fx.db.collection('affiliate_bank_accounts').get();
  await fx.svc.verifyBankAccount('admin_samuel', banks.docs[0].id);
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end(payload) { this.body = payload; return this; },
  };
}

function fakeAdmin(userId, { isAdmin = false, role = 'admin', authTime = Math.floor(Date.now() / 1000) } = {}) {
  const chain = (table) => ({
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => {
      if (table === 'users') return { data: { account_status: 'active' }, error: null };
      if (table === 'admin_users') return { data: isAdmin ? { role, is_active: true } : null, error: null };
      return { data: null, error: null };
    },
  });
  return {
    provider: 'firebase',
    auth: {
      getUser: async () => ({ data: { user: { id: userId, email: 'user@example.com', user_metadata: { name: 'User' } } }, error: null }),
      verifyIdToken: async () => ({ uid: userId, auth_time: authTime }),
    },
    from: chain,
  };
}

test('affiliate registers and receives the existing referral code as a link', async () => {
  const fx = await readyAffiliate();
  assert.equal(fx.applied.affiliate.status, 'pending');
  assert.equal(fx.applied.affiliate.link, null);
  assert.equal(fx.approved.status, 'active');
  assert.equal(fx.approved.code, 'ABC123');
  assert.equal(fx.approved.link, 'https://live.morphly.fun/ref/ABC123');
});

test('six referred purchases of ₦12,500 earn ₦4,500 and stay pending for 7 days', async () => {
  const fx = await readyAffiliate();
  for (let i = 1; i <= 6; i += 1) {
    const uid = `cust_${i}`;
    await fx.svc.attributeReferral({ referredUserId: uid, code: 'ABC123', name: `Customer ${i}` });
    const result = await fx.svc.recordQualifyingPurchase({ referredUserId: uid, paymentTxId: `pay_${i}`, packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
    assert.equal(result.commission.amountKobo, COMMISSION);
  }
  const stats = await fx.svc.statsFor('aff_amina');
  assert.equal(stats.wallet.lifetimeEarnedKobo, 450000);
  assert.equal(stats.wallet.pendingKobo, 450000);
  assert.equal(stats.wallet.availableKobo, 0);
  assert.equal(stats.payingReferrals, 6);
  assert.equal(stats.commissions.length, 6);
});

test('three purchases inside one 30-day window all earn commission', async () => {
  const fx = await readyAffiliate();
  await fx.svc.attributeReferral({ referredUserId: 'cust_repeat', code: 'ABC123', name: 'Repeat Buyer' });
  for (const [index, id] of ['pay_a', 'pay_b', 'pay_c'].entries()) {
    if (index) fx.addDays(10);
    const result = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_repeat', paymentTxId: id, packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
    assert.equal(result.skipped, false);
    assert.equal(result.commission.amountKobo, COMMISSION);
  }
  const stats = await fx.svc.statsFor('aff_amina');
  assert.equal(stats.commissions.length, 3);
  assert.equal(stats.wallet.lifetimeEarnedKobo, 225000);
});

test('a purchase after the 30-day window earns nothing', async () => {
  const fx = await readyAffiliate();
  await fx.svc.attributeReferral({ referredUserId: 'cust_late', code: 'ABC123', name: 'Late Buyer' });
  const first = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_late', paymentTxId: 'pay_first', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  assert.equal(first.commission.amountKobo, COMMISSION);
  fx.addDays(31);
  const late = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_late', paymentTxId: 'pay_late', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  assert.equal(late.skipped, true);
  assert.equal(late.reason, 'window_expired');
  const stats = await fx.svc.statsFor('aff_amina');
  assert.equal(stats.commissions.length, 1);
  assert.equal(stats.wallet.lifetimeEarnedKobo, COMMISSION);
});

test('₦3,000 withdrawal is approved manually, transfer recorded, then paid', async () => {
  const fx = await readyAffiliate();
  for (let i = 1; i <= 6; i += 1) {
    await fx.svc.attributeReferral({ referredUserId: `cust_${i}`, code: 'ABC123', name: `Customer ${i}` });
    await fx.svc.recordQualifyingPurchase({ referredUserId: `cust_${i}`, paymentTxId: `pay_${i}`, packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  }
  fx.addDays(7);
  const before = await fx.svc.statsFor('aff_amina');
  assert.equal(before.wallet.availableKobo, 450000);
  assert.equal(before.wallet.pendingKobo, 0);
  await bank(fx);
  const withdrawal = await fx.svc.requestWithdrawal({ userId: 'aff_amina', amountKobo: 300000, authTime: Math.floor(fx.state.clock / 1000) });
  assert.equal(withdrawal.status, 'pending');
  const reserved = await fx.svc.statsFor('aff_amina');
  assert.equal(reserved.wallet.availableKobo, 150000);
  assert.equal(reserved.wallet.reservedKobo, 300000);
  await fx.svc.decideWithdrawal('admin_samuel', withdrawal.id, 'approve');
  await fx.svc.decideWithdrawal('admin_samuel', withdrawal.id, 'transfer', { transferRef: 'TRF-FLW-88321' });
  const paid = await fx.svc.decideWithdrawal('admin_samuel', withdrawal.id, 'paid');
  assert.equal(paid.withdrawal.status, 'paid');
  assert.equal(paid.withdrawal.transferRef, 'TRF-FLW-88321');
  const after = await fx.svc.statsFor('aff_amina');
  assert.equal(after.wallet.availableKobo, 150000);
  assert.equal(after.wallet.reservedKobo, 0);
  assert.equal(after.wallet.withdrawnKobo, 300000);
});

test('refund reverses a pending commission and a paid-out commission becomes debt that offsets the next one', async () => {
  const fx = await readyAffiliate();
  await fx.svc.attributeReferral({ referredUserId: 'cust_refund', code: 'ABC123', name: 'Refunded Buyer' });
  await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_refund', paymentTxId: 'pay_refund', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  const before = await fx.svc.statsFor('aff_amina');
  assert.equal(before.wallet.pendingKobo, COMMISSION);
  const creditsBefore = 80;
  await fx.db.collection('wallets').doc('cust_refund').set({ user_id: 'cust_refund', credits: creditsBefore });
  const reversed = await fx.svc.refundPayment({ paymentTxId: 'pay_refund', adminId: 'admin_samuel', reason: 'Provider refund' });
  assert.equal(reversed.reversed, true);
  assert.equal(reversed.previousStatus, 'pending');
  assert.equal(reversed.customerCreditsUnchanged, true);
  assert.equal((await fx.db.collection('wallets').doc('cust_refund').get()).data().credits, creditsBefore);
  const again = await fx.svc.refundPayment({ paymentTxId: 'pay_refund', adminId: 'admin_samuel', reason: 'Provider refund' });
  assert.equal(again.duplicate, true);
  const after = await fx.svc.statsFor('aff_amina');
  assert.equal(after.wallet.pendingKobo, 0);
  assert.equal(after.wallet.availableKobo, 0);
  assert.equal(after.wallet.lifetimeEarnedKobo, 0);
  assert.equal(after.wallet.lifetimeReversedKobo, COMMISSION);
  assert.equal(after.commissions[0].status, 'reversed');

  for (let i = 1; i <= 6; i += 1) {
    await fx.svc.attributeReferral({ referredUserId: `paid_${i}`, code: 'ABC123', name: `Paid ${i}` });
    await fx.svc.recordQualifyingPurchase({ referredUserId: `paid_${i}`, paymentTxId: `pay_paid_${i}`, packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  }
  fx.addDays(7);
  await bank(fx);
  const withdrawal = await fx.svc.requestWithdrawal({ userId: 'aff_amina', amountKobo: 450000, authTime: Math.floor(fx.state.clock / 1000) });
  await fx.svc.decideWithdrawal('admin_samuel', withdrawal.id, 'approve');
  await fx.svc.decideWithdrawal('admin_samuel', withdrawal.id, 'paid', { transferRef: 'TRF-DEBT-1' });
  const debt = await fx.svc.refundPayment({ paymentTxId: 'pay_paid_1', adminId: 'admin_samuel', reason: 'Chargeback after payout' });
  assert.equal(debt.wallet.clawbackDueKobo, COMMISSION);
  assert.equal(debt.wallet.availableKobo, 0);
  await fx.svc.attributeReferral({ referredUserId: 'cust_next', code: 'ABC123', name: 'Next Buyer' });
  await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_next', paymentTxId: 'pay_next', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  fx.addDays(7);
  const settled = await fx.svc.statsFor('aff_amina');
  assert.equal(settled.wallet.clawbackDueKobo, 0);
  assert.equal(settled.wallet.availableKobo, 0);
  assert.equal(settled.wallet.withdrawnKobo, 450000);
});

test('raising the default rate from 6% to 8% leaves existing windows at 6%', async () => {
  const fx = await readyAffiliate();
  await fx.svc.attributeReferral({ referredUserId: 'cust_old', code: 'ABC123', name: 'Existing Referral' });
  const first = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_old', paymentTxId: 'pay_old', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  assert.equal(first.commission.rateBps, 600);
  assert.equal(first.commission.amountKobo, COMMISSION);
  await fx.svc.updateSettings('admin_samuel', { defaultRateBps: 800 }, { superAdmin: true });
  const repeat = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_old', paymentTxId: 'pay_old_2', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  assert.equal(repeat.commission.rateBps, 600);
  assert.equal(repeat.commission.amountKobo, COMMISSION);
  await fx.svc.attributeReferral({ referredUserId: 'cust_new', code: 'ABC123', name: 'New Referral' });
  const newer = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_new', paymentTxId: 'pay_new', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  assert.equal(newer.commission.rateBps, 800);
  assert.equal(newer.commission.amountKobo, 100000);
});

test('the same payment id creates one commission', async () => {
  const fx = await readyAffiliate();
  await fx.svc.attributeReferral({ referredUserId: 'cust_dup', code: 'ABC123', name: 'Duplicate Webhook' });
  const first = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_dup', paymentTxId: 'pay_dup', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  const second = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_dup', paymentTxId: 'pay_dup', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.commission.id, first.commission.id);
  const stats = await fx.svc.statsFor('aff_amina');
  assert.equal(stats.commissions.length, 1);
  assert.equal(stats.wallet.lifetimeEarnedKobo, COMMISSION);
});

test('non-affiliate purchases still grant credits and the 200-credit reward', async () => {
  const db = createMemoryFirestore();
  await db.collection('users').doc('buyer').set({ id: 'buyer', account_status: 'active' });
  await db.collection('users').doc('referrer').set({ id: 'referrer', account_status: 'active', referral_code: 'PLAIN01' });
  await db.collection('wallets').doc('buyer-wallet').set({ id: 'buyer-wallet', user_id: 'buyer', credits: 0 });
  await db.collection('wallets').doc('referrer-wallet').set({ id: 'referrer-wallet', user_id: 'referrer', credits: 10 });
  await db.collection('credit_packages').doc('pkg').set({ id: 'pkg', name: 'Starter', credits: 100, price_ngn: '12500.00', status: 'active', is_active: true });
  await db.collection('referrals').doc('ref').set({ id: 'ref', referrer_user_id: 'referrer', referred_user_id: 'buyer', status: 'registered', referral_code_used: 'PLAIN01' });
  const runtime = createPaymentRuntime(db);
  const result = await runtime.applyPayment({ userId: 'buyer', packageId: 'pkg', reference: 'ref-non-affiliate', gateway: 'flutterwave', gatewayId: 'charge-1', amount: '12500.00', fee: 0 });
  assert.equal(result.referralRewarded, true);
  assert.equal((await db.collection('wallets').doc('buyer-wallet').get()).data().credits, 100);
  assert.equal((await db.collection('wallets').doc('referrer-wallet').get()).data().credits, 210);
  assert.equal((await db.collection('affiliate_commissions').get()).size, 0);
  const signup = await createAffiliateService(db).recordQualifyingPurchase({ referredUserId: 'buyer', paymentTxId: 'signup:buyer', packagePriceKobo: PURCHASE, transactionType: 'signup_bonus' });
  assert.equal(signup.skipped, true);
  assert.equal(signup.reason, 'non_paid_credits');
});

test('an approved affiliate referral does not also get the 200 credits, and a duplicate webhook does not double either', async () => {
  const fx = await readyAffiliate();
  await fx.db.collection('users').doc('buyer').set({ id: 'buyer', account_status: 'active' });
  await fx.db.collection('wallets').doc('buyer-wallet').set({ id: 'buyer-wallet', user_id: 'buyer', credits: 0 });
  await fx.db.collection('wallets').doc('aff-wallet').set({ id: 'aff-wallet', user_id: 'aff_amina', credits: 10 });
  await fx.db.collection('credit_packages').doc('pkg').set({ id: 'pkg', name: 'Starter', credits: 100, price_ngn: '12500.00', status: 'active', is_active: true });
  await fx.db.collection('referrals').doc('ref').set({ id: 'ref', referrer_user_id: 'aff_amina', referred_user_id: 'buyer', status: 'registered' });
  await fx.svc.attributeReferral({ referredUserId: 'buyer', code: 'ABC123', name: 'Buyer', email: 'buyer@example.com' });
  const runtime = createPaymentRuntime(fx.db);
  const input = { userId: 'buyer', packageId: 'pkg', reference: 'ref-affiliate', gateway: 'flutterwave', gatewayId: 'charge-aff', amount: '13000.00', fee: '50.00' };
  const first = await runtime.applyPayment(input);
  const second = await runtime.applyPayment(input);
  assert.equal(first.referralRewarded, false);
  assert.equal(first.creditsAdded, 100);
  assert.equal(second.duplicate, true);
  assert.equal((await fx.db.collection('wallets').doc('buyer-wallet').get()).data().credits, 100);
  assert.equal((await fx.db.collection('wallets').doc('aff-wallet').get()).data().credits, 10);
  const stats = await fx.svc.statsFor('aff_amina');
  assert.equal(stats.commissions.length, 1);
  assert.equal(stats.commissions[0].purchaseKobo, 1250000);
  assert.equal(stats.commissions[0].amountKobo, COMMISSION);
  assert.equal(nairaToKobo(10 * 1500), 1500000);
  const crypto = await fx.svc.recordQualifyingPurchase({ referredUserId: 'buyer', paymentTxId: 'ivorypay:no-fiat', settlementUnverified: true, transactionType: 'credit_purchase', currency: 'USD' });
  assert.equal(crypto.skipped, true);
  assert.equal(crypto.reason, 'currency_not_ngn');
});

test('velocity-flagged referrals hold commission until an admin clears them', async () => {
  const fx = await readyAffiliate();
  await fx.svc.attributeReferral({ referredUserId: 'cust_fast', code: 'ABC123', name: 'Fast', suspicious: true });
  const held = await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_fast', paymentTxId: 'pay_fast', packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  assert.equal(held.commission.status, 'held');
  const before = await fx.svc.statsFor('aff_amina');
  assert.equal(before.wallet.pendingKobo, 0);
  assert.equal(before.wallet.heldKobo, COMMISSION);
  await fx.svc.clearSuspicion('admin_samuel', 'cust_fast');
  const after = await fx.svc.statsFor('aff_amina');
  assert.equal(after.wallet.heldKobo, 0);
  assert.equal(after.wallet.pendingKobo, COMMISSION);
});

test('registrations stay off until a super admin enables them, and automatic payouts cannot be turned on', async () => {
  const db = createMemoryFirestore();
  const svc = createAffiliateService(db);
  await db.collection('users').doc('person').set({ id: 'person', account_status: 'active', referral_code: 'ABC123' });
  await assert.rejects(svc.apply({ userId: 'person', name: 'Person', email: 'p@example.com', acceptTerms: true }), /closed/);
  const saved = await svc.updateSettings('admin_samuel', { registrationsEnabled: true, autoPayoutsEnabled: true }, { superAdmin: true });
  assert.equal(saved.settings.registrationsEnabled, true);
  assert.equal(saved.settings.autoPayoutsEnabled, false);
  await assert.rejects(svc.updateSettings('admin_samuel', { defaultRateBps: 700 }, { superAdmin: false }), /Super admin/);
});

test('bank changes and withdrawals require a fresh sign-in, a 10-digit NUBAN, and integer kobo', async () => {
  const fx = await readyAffiliate();
  await assert.rejects(fx.svc.saveBankAccount({
    userId: 'aff_amina', bankCode: '058', accountNumber: '0123456789', accountName: 'AMINA OKONKWO', authTime: Math.floor(fx.state.clock / 1000) - 3600,
  }), /Re-authentication/);
  await assert.rejects(fx.svc.saveBankAccount({
    userId: 'aff_amina', bankCode: '058', accountNumber: '12345', accountName: 'AMINA OKONKWO', authTime: Math.floor(fx.state.clock / 1000),
  }), /10-digit/);
  await assert.rejects(fx.svc.requestWithdrawal({ userId: 'aff_amina', amountKobo: 3000.5, authTime: Math.floor(fx.state.clock / 1000) }), /integer/);
});

test('rejected and failed withdrawals release the reserve once', async () => {
  const fx = await readyAffiliate();
  await fx.svc.attributeReferral({ referredUserId: 'cust_1', code: 'ABC123', name: 'Customer' });
  await fx.svc.recordQualifyingPurchase({ referredUserId: 'cust_1', paymentTxId: 'pay_1', packagePriceKobo: PURCHASE * 6, transactionType: 'credit_purchase', currency: 'NGN' });
  fx.addDays(7);
  await bank(fx);
  const withdrawal = await fx.svc.requestWithdrawal({ userId: 'aff_amina', amountKobo: 300000, authTime: Math.floor(fx.state.clock / 1000) });
  await fx.svc.decideWithdrawal('admin_samuel', withdrawal.id, 'reject', { reason: 'Name mismatch' });
  await fx.svc.decideWithdrawal('admin_samuel', withdrawal.id, 'reject', { reason: 'Name mismatch' });
  const stats = await fx.svc.statsFor('aff_amina');
  assert.equal(stats.wallet.reservedKobo, 0);
  assert.equal(stats.wallet.availableKobo, 450000);
});

test('signup through an active affiliate records attribution and does not make them an admin', async () => {
  const db = createMemoryFirestore();
  const ops = createFirebaseOperations(db, { getUser: async () => ({ email: 'buyer@example.com' }) });
  await db.collection('users').doc('aff_amina').set({ id: 'aff_amina', account_status: 'active', referral_code: 'ABCD23', email: 'amina@example.com' });
  await db.collection('affiliates').doc('aff_amina').set({ user_id: 'aff_amina', status: 'active', code: 'ABCD23' });
  await ops.provision({ id: 'buyer', email: 'buyer@example.com', user_metadata: { name: 'Buyer' } }, 'ABCD23');
  const attribution = await db.collection('affiliate_attributions').doc('buyer').get();
  assert.equal(attribution.exists, true);
  assert.equal(attribution.data().affiliate_id, 'aff_amina');
  assert.equal(attribution.data().masked_label.includes('@'), true);
  assert.equal((await db.collection('admin_users').doc('aff_amina').get()).exists, false);
  assert.equal((await db.collection('admin_users').doc('buyer').get()).exists, false);
});

test('admin withdrawal review shows the full account number only to admins and audits the view', async () => {
  const fx = await readyAffiliate({ estimatedTransferFeeKobo: 5000 });
  await fx.svc.attributeReferral({ referredUserId: 'cust_1', code: 'ABC123', name: 'Customer' });
  for (let i = 1; i <= 6; i += 1) {
    await fx.svc.attributeReferral({ referredUserId: `fee_${i}`, code: 'ABC123', name: `Customer ${i}` });
    await fx.svc.recordQualifyingPurchase({ referredUserId: `fee_${i}`, paymentTxId: `fee_pay_${i}`, packagePriceKobo: PURCHASE, transactionType: 'credit_purchase', currency: 'NGN' });
  }
  fx.addDays(7);
  await bank(fx);
  await fx.svc.requestWithdrawal({ userId: 'aff_amina', amountKobo: 300000, authTime: Math.floor(fx.state.clock / 1000) });
  const userView = await fx.svc.dashboard('aff_amina');
  assert.equal(userView.bank.accountNumberMasked.endsWith('6789'), true);
  assert.equal(JSON.stringify(userView).includes('0123456789'), false);
  assert.equal(userView.withdrawals[0].netKobo, 295000);
  const admin = fakeAdmin('admin_samuel', { isAdmin: true, role: 'super_admin' });
  const handler = createAdminAffiliateHandler({ supabaseAdmin: admin, db: fx.db });
  const res = mockRes();
  await handler({ method: 'GET', query: { view: 'withdrawals', status: 'all' }, body: {}, headers: { authorization: 'Bearer token', 'content-type': 'application/json' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.manualPayouts, true);
  assert.equal(res.body.autoPayoutsAvailable, false);
  assert.equal(res.body.withdrawals[0].bank.accountNumber, '0123456789');
  assert.equal(res.body.withdrawals[0].bank.accountName, 'AMINA OKONKWO');
  assert.equal(res.body.withdrawals[0].netKobo, 295000);
  const audit = await fx.svc.listAudit();
  assert.equal(audit.some((row) => row.action === 'withdrawal.queue_viewed'), true);
  assert.equal(JSON.stringify(audit).includes('0123456789'), false);
});

test('a normal user receives 403 on every admin affiliate action without affiliate data', async () => {
  const db = createMemoryFirestore();
  await db.collection('affiliate_bank_accounts').doc('secret').set({ account_number: '0123456789', active: true, affiliate_id: 'someone' });
  const handler = createAdminAffiliateHandler({ supabaseAdmin: fakeAdmin('user-1', { isAdmin: false }), db });
  for (const action of [...ADMIN_AFFILIATE_ACTIONS, 'not-a-real-action']) {
    const res = mockRes();
    await handler({
      method: action === 'overview' ? 'GET' : 'POST',
      query: { view: action },
      body: { action, affiliateId: 'someone', accountNumber: '0123456789' },
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    }, res);
    assert.equal(res.statusCode, 403, action);
    assert.deepEqual(res.body, { error: 'Admin access required' });
    assert.equal(JSON.stringify(res.body).includes('0123456789'), false);
  }
});

test('affiliate requests reject another user id, a foreign origin, and repeated bank saves', async () => {
  const fx = await readyAffiliate();
  const handler = createUserAffiliateHandler({
    supabaseAdmin: fakeAdmin('aff_amina', { authTime: Math.floor(Date.now() / 1000) }),
    db: fx.db,
    auth: fakeAdmin('aff_amina').auth,
  });
  const mismatch = mockRes();
  await handler({ method: 'POST', query: {}, body: { action: 'apply', acceptTerms: true, userId: 'someone-else' }, headers: { authorization: 'Bearer token', 'content-type': 'application/json' } }, mismatch);
  assert.equal(mismatch.statusCode, 403);
  const origin = mockRes();
  await handler({ method: 'POST', query: {}, body: { action: 'apply', acceptTerms: true }, headers: { authorization: 'Bearer token', 'content-type': 'application/json', origin: 'https://evil.example' } }, origin);
  assert.equal(origin.statusCode, 403);
  const plain = mockRes();
  await handler({ method: 'POST', query: {}, body: { action: 'save-bank' }, headers: { authorization: 'Bearer token', 'content-type': 'text/plain', origin: 'https://live.morphly.fun' } }, plain);
  assert.equal(plain.statusCode, 415);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = mockRes();
    await handler({
      method: 'POST', query: {},
      body: { action: 'save-bank', bankCode: '058', accountNumber: '0123456789', accountName: 'AMINA OKONKWO' },
      headers: { authorization: 'Bearer token', 'content-type': 'application/json', origin: 'https://live.morphly.fun' },
    }, res);
    assert.equal(res.statusCode, 200, `attempt ${attempt}`);
  }
  const limited = mockRes();
  await handler({
    method: 'POST', query: {},
    body: { action: 'save-bank', bankCode: '058', accountNumber: '0123456789', accountName: 'AMINA OKONKWO' },
    headers: { authorization: 'Bearer token', 'content-type': 'application/json', origin: 'https://live.morphly.fun' },
  }, limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(JSON.stringify(limited.body).includes('0123456789'), false);
});

test('the user app source has no affiliate admin client and the streaming controls stay intact', () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx|ts|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(appDirectory, 'src'));
  const bundle = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(bundle, /admin-affiliates|affiliate-admin|MorphlyAffiliateAdmin|withdrawal-paid|queue_viewed/);
  const dashboard = fs.readFileSync(path.join(appDirectory, 'src/pages/Dashboard.tsx'), 'utf8');
  const entry = fs.readFileSync(path.join(appDirectory, 'src/hooks/useAffiliateEntry.ts'), 'utf8');
  assert.match(dashboard, /data-testid="affiliate-program-button"/);
  assert.match(dashboard, /affiliateEntry \?/);
  assert.match(entry, /registrationsEnabled/);
  assert.doesNotMatch(dashboard, />Live output</);
  assert.match(dashboard, /Exit Full Screen/);
  assert.match(dashboard, /data-testid="realtime-provider-selector"/);
  assert.match(dashboard, /getRealtimeProviderLabel/);
  const rules = fs.readFileSync(path.join(root, 'firestore/affiliate.rules'), 'utf8');
  for (const collection of ['affiliate_wallets', 'affiliate_ledger', 'affiliate_withdrawals', 'affiliate_bank_accounts', 'affiliate_commissions']) {
    assert.match(rules, new RegExp(`match /${collection}/\\{id\\} \\{ allow read, write: if false; \\}`));
  }
  const adminJs = fs.readFileSync(path.join(root, 'morphly-admin-dashboard/affiliate-admin.js'), 'utf8');
  assert.match(adminJs, /Manual payouts only/);
  assert.match(adminJs, /data-copy/);
  assert.match(adminJs, /Mark paid/);
  assert.match(adminJs, /disabled> Automatic payouts/);
});
