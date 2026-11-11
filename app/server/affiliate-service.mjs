import { randomUUID } from 'node:crypto';
import { hash } from './firebase-store.js';
import {
  DAY_MS,
  affiliateError,
  affiliateLink,
  assertRecentAuth,
  bankByCode,
  effectiveBanks,
  normalizeBankCode,
  normalizeBankName,
  publicBanks,
  selectableBank,
  buildSignupAttribution,
  commissionKobo,
  csvCell,
  emptyWallet,
  formatNgn,
  formatRate,
  isNuban,
  maskCustomer,
  netPayoutKobo,
  normalizeSettings,
  presentBank,
  requireKobo,
  settingsToDoc,
  validateSettingsPatch,
  walletView,
} from '../../shared/affiliate-program.mjs';

const SETTINGS_DOC = 'current';

function iso(now) {
  return new Date(now).toISOString();
}

function assertAccountName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z][A-Za-z .'-]{1,79}$/.test(name)) {
    throw affiliateError('Enter the account name as it appears at the bank');
  }
  return name;
}

function assertTransferRef(value) {
  const ref = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_/ ]{2,80}$/.test(ref)) {
    throw affiliateError('A bank transfer reference is required');
  }
  return ref;
}

export function createAffiliateService(db, options = {}) {
  const now = () => (options.now ? options.now() : Date.now());
  const col = (name) => db.collection(name);

  async function readSettings() {
    const snap = await col('affiliate_settings').doc(SETTINGS_DOC).get();
    return normalizeSettings(snap.exists ? snap.data() : null);
  }

  async function readBankOverrides() {
    const snap = await col('affiliate_banks').get();
    return snap.docs.map((doc) => bankOverrideFromDoc(doc));
  }

  function bankOverrideFromDoc(doc) {
    const data = doc.data() || {};
    const id = String(doc.id || '').trim();
    const code = /^\d{3,6}$/.test(id) ? id : String(data.code || '').trim();
    return { ...data, code };
  }

  function presentCatalogBank(bank) {
    return {
      code: bank.code,
      name: bank.name,
      enabled: bank.enabled !== false,
      builtin: Boolean(bank.builtin),
      createdAt: bank.created_at || bank.createdAt || null,
      updatedAt: bank.updated_at || bank.updatedAt || null,
      updatedBy: bank.updated_by || bank.updatedBy || null,
    };
  }

  async function writeAudit(entry) {
    const id = randomUUID();
    await col('affiliate_audit').doc(id).set({
      id,
      at: now(),
      created_at: iso(now()),
      ...entry,
    });
    return id;
  }

  function auditTx(tx, entry) {
    const id = randomUUID();
    tx.create(col('affiliate_audit').doc(id), {
      id,
      at: now(),
      created_at: iso(now()),
      ...entry,
    });
  }

  function ledgerTx(tx, entry) {
    const id = randomUUID();
    tx.create(col('affiliate_ledger').doc(id), {
      id,
      at: now(),
      created_at: iso(now()),
      ...entry,
    });
  }

  async function releaseDue(affiliateId) {
    const snap = await col('affiliate_commissions').where('status', '==', 'pending').get();
    const due = snap.docs
      .map((doc) => doc.data())
      .filter((row) => row.available_at <= now() && (!affiliateId || row.affiliate_id === affiliateId));
    const groups = new Map();
    for (const row of due) {
      const list = groups.get(row.affiliate_id) || [];
      list.push(row);
      groups.set(row.affiliate_id, list);
    }
    for (const [id, rows] of groups) {
      await db.runTransaction(async (tx) => {
        const walletRef = col('affiliate_wallets').doc(id);
        const walletSnap = await tx.get(walletRef);
        const commissionSnaps = await Promise.all(rows.map((row) => tx.get(col('affiliate_commissions').doc(row.id))));
        const wallet = { ...(walletSnap.exists ? walletSnap.data() : emptyWallet(id)) };
        for (const commissionSnap of commissionSnaps) {
          if (!commissionSnap.exists) continue;
          const commission = commissionSnap.data();
          if (commission.status !== 'pending' || commission.available_at > now()) continue;
          const amount = commission.amount_kobo;
          const offset = Math.min(wallet.clawback_due_kobo || 0, amount);
          wallet.clawback_due_kobo = (wallet.clawback_due_kobo || 0) - offset;
          wallet.pending_kobo = (wallet.pending_kobo || 0) - amount;
          wallet.available_kobo = (wallet.available_kobo || 0) + (amount - offset);
          tx.update(commissionSnap.ref, { status: 'available', available_released_at: now(), updated_at: iso(now()) });
          if (offset > 0) {
            ledgerTx(tx, {
              affiliate_id: id,
              type: 'commission_debt_offset',
              amount_kobo: -offset,
              commission_id: commission.id,
              payment_tx_id: commission.payment_tx_id,
            });
          }
          ledgerTx(tx, {
            affiliate_id: id,
            type: 'commission_available',
            amount_kobo: amount - offset,
            commission_id: commission.id,
            payment_tx_id: commission.payment_tx_id,
          });
        }
        wallet.updated_at = iso(now());
        tx.set(walletRef, wallet, { merge: true });
      });
    }
  }

  async function activeBank(tx, affiliateId) {
    const snap = await tx.get(col('affiliate_bank_accounts').where('affiliate_id', '==', affiliateId));
    return snap.docs.map((doc) => doc.data()).find((row) => row.active) || null;
  }

  function commissionView(row) {
    return {
      id: row.id,
      status: row.status,
      amountKobo: row.amount_kobo,
      purchaseKobo: row.purchase_kobo,
      rateBps: row.rate_bps,
      createdAt: row.created_at,
      availableAt: row.available_at ? new Date(row.available_at).toISOString() : null,
      paymentTxId: row.payment_tx_id,
      holdReason: row.hold_reason || null,
    };
  }

  function referralView(row) {
    return {
      id: row.id,
      maskedLabel: row.masked_label || 'C***',
      status: row.status,
      registeredAt: new Date(row.registered_at).toISOString(),
      windowEndsAt: row.window_ends_at ? new Date(row.window_ends_at).toISOString() : null,
      earnedKobo: row.earned_kobo || 0,
      purchaseCount: row.purchase_count || 0,
    };
  }

  function withdrawalView(row, { reveal = false } = {}) {
    const bank = row.bank_snapshot || {};
    const presented = presentBank(bank, { reveal });
    return {
      id: row.id,
      affiliateId: reveal ? row.affiliate_id : undefined,
      affiliateName: reveal ? row.affiliate_name || '' : undefined,
      status: row.status,
      amountKobo: row.amount_kobo,
      feeKobo: row.fee_kobo,
      netKobo: row.net_kobo,
      transferFeePayer: row.transfer_fee_payer,
      createdAt: row.created_at,
      transferRef: row.transfer_ref || null,
      failureReason: row.failure_reason || null,
      bank: presented,
      manualPayout: true,
    };
  }

  async function dashboard(userId) {
    const affiliateSnap = await col('affiliates').doc(userId).get();
    const settings = await readSettings();
    if (affiliateSnap.exists) await releaseDue(userId);
    const affiliate = affiliateSnap.exists ? affiliateSnap.data() : null;
    const [walletSnap, referralsSnap, commissionsSnap, withdrawalsSnap, banksSnap] = await Promise.all([
      col('affiliate_wallets').doc(userId).get(),
      affiliate ? col('affiliate_attributions').where('affiliate_id', '==', userId).get() : Promise.resolve({ docs: [] }),
      affiliate ? col('affiliate_commissions').where('affiliate_id', '==', userId).get() : Promise.resolve({ docs: [] }),
      affiliate ? col('affiliate_withdrawals').where('affiliate_id', '==', userId).get() : Promise.resolve({ docs: [] }),
      affiliate ? col('affiliate_bank_accounts').where('affiliate_id', '==', userId).get() : Promise.resolve({ docs: [] }),
    ]);
    const referrals = referralsSnap.docs.map((doc) => doc.data());
    const paying = referrals.filter((row) => (row.purchase_count || 0) > 0);
    const bank = banksSnap.docs.map((doc) => doc.data()).find((row) => row.active) || null;
    const rateBps = affiliate?.rate_bps_override ?? settings.defaultRateBps;
    return {
      program: {
        registrationsEnabled: settings.registrationsEnabled,
        commissionsEnabled: settings.commissionsEnabled,
        defaultRateBps: settings.defaultRateBps,
        durationDays: settings.durationDays,
        maxDaysBeforeFirstPurchase: settings.maxDaysBeforeFirstPurchase,
        minWithdrawalKobo: settings.minWithdrawalKobo,
        holdDays: settings.holdDays,
        estimatedTransferFeeKobo: settings.estimatedTransferFeeKobo,
        transferFeePayer: settings.transferFeePayer,
        payoutsManual: true,
        autoPayoutsAvailable: false,
        earnLabel: `Earn ${formatRate(settings.defaultRateBps)}`,
      },
      affiliate: affiliate ? {
        status: affiliate.status,
        code: affiliate.code || null,
        link: affiliate.link || null,
        rateBps,
        termsAcceptedAt: affiliate.terms_accepted_at || null,
        rejectionReason: affiliate.status === 'rejected' ? affiliate.rejection_reason || '' : undefined,
      } : null,
      wallet: walletView(walletSnap.exists ? walletSnap.data() : null),
      stats: {
        totalReferrals: referrals.length,
        payingReferrals: paying.length,
        activeWindowReferrals: referrals.filter((row) => row.status === 'active').length,
        expiredReferrals: referrals.filter((row) => row.status === 'expired' || row.status === 'expired_unactivated').length,
        conversionRate: referrals.length ? paying.length / referrals.length : 0,
      },
      referrals: referrals
        .sort((a, b) => b.registered_at - a.registered_at)
        .map(referralView),
      commissions: commissionsSnap.docs
        .map((doc) => doc.data())
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map(commissionView),
      withdrawals: withdrawalsSnap.docs
        .map((doc) => doc.data())
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((row) => withdrawalView(row, { reveal: false })),
      bank: presentBank(bank, { reveal: false }),
      banks: publicBanks(await readBankOverrides()),
    };
  }

  async function apply({ userId, name, email, acceptTerms }) {
    if (!userId) throw affiliateError('Sign in required', 401);
    if (acceptTerms !== true) throw affiliateError('Affiliate terms must be accepted');
    return db.runTransaction(async (tx) => {
      const [settingsSnap, existing, profile] = await Promise.all([
        tx.get(col('affiliate_settings').doc(SETTINGS_DOC)),
        tx.get(col('affiliates').doc(userId)),
        tx.get(col('users').doc(userId)),
      ]);
      if (existing.exists) return { duplicate: true, affiliate: { status: existing.data().status, code: existing.data().code || null, link: existing.data().link || null } };
      const settings = normalizeSettings(settingsSnap.exists ? settingsSnap.data() : null);
      if (!settings.registrationsEnabled) throw affiliateError('Affiliate registrations are closed');
      if (!profile.exists || profile.data().account_status !== 'active') throw affiliateError('Account unavailable', 403);
      const status = settings.manualAffiliateApproval ? 'pending' : 'active';
      const code = status === 'active' ? profile.data().referral_code : null;
      if (status === 'active' && !code) throw affiliateError('Referral code is not ready yet');
      const record = {
        id: userId,
        user_id: userId,
        name: String(name || profile.data().name || 'Affiliate').slice(0, 80),
        email: String(email || profile.data().email || '').slice(0, 120),
        status,
        code: code || null,
        link: code ? affiliateLink(code) : null,
        rate_bps_override: null,
        flagged: false,
        flag_reason: null,
        terms_accepted_at: iso(now()),
        terms_version: '2026-11-11',
        created_at: iso(now()),
        updated_at: iso(now()),
        approved_at: status === 'active' ? iso(now()) : null,
      };
      tx.create(col('affiliates').doc(userId), record);
      tx.create(col('affiliate_wallets').doc(userId), { ...emptyWallet(userId), created_at: iso(now()), updated_at: iso(now()) });
      auditTx(tx, { action: 'affiliate.applied', actor: userId, affiliate_id: userId, payload: { status } });
      return { duplicate: false, affiliate: { status, code: record.code, link: record.link } };
    });
  }

  async function approve(adminId, affiliateId) {
    return db.runTransaction(async (tx) => {
      const [affiliateSnap, profile] = await Promise.all([
        tx.get(col('affiliates').doc(affiliateId)),
        tx.get(col('users').doc(affiliateId)),
      ]);
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      const affiliate = affiliateSnap.data();
      if (affiliate.status === 'rejected') throw affiliateError('Rejected applications cannot be approved');
      if (affiliate.status === 'active') return { status: 'active', code: affiliate.code, link: affiliate.link };
      const code = profile.data()?.referral_code;
      if (!code) throw affiliateError('This user has no referral code yet');
      const link = affiliateLink(code);
      tx.update(affiliateSnap.ref, { status: 'active', code, link, approved_at: iso(now()), approved_by: adminId, updated_at: iso(now()) });
      auditTx(tx, { action: 'affiliate.approved', actor: adminId, affiliate_id: affiliateId, payload: { code } });
      return { status: 'active', code, link };
    });
  }

  async function reject(adminId, affiliateId, reason) {
    const text = String(reason || '').trim();
    if (text.length < 3) throw affiliateError('A reason is required');
    return db.runTransaction(async (tx) => {
      const affiliateSnap = await tx.get(col('affiliates').doc(affiliateId));
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      tx.update(affiliateSnap.ref, { status: 'rejected', rejection_reason: text.slice(0, 240), rejected_at: iso(now()), updated_at: iso(now()) });
      auditTx(tx, { action: 'affiliate.rejected', actor: adminId, affiliate_id: affiliateId, payload: { reason: text.slice(0, 240) } });
      return { status: 'rejected' };
    });
  }

  async function setStatus(adminId, affiliateId, status, reason) {
    if (status !== 'active' && status !== 'suspended') throw affiliateError('Invalid status');
    const text = String(reason || '').trim();
    if (text.length < 3) throw affiliateError('A reason is required');
    return db.runTransaction(async (tx) => {
      const affiliateSnap = await tx.get(col('affiliates').doc(affiliateId));
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      tx.update(affiliateSnap.ref, { status, status_reason: text.slice(0, 240), updated_at: iso(now()) });
      auditTx(tx, { action: status === 'suspended' ? 'affiliate.suspended' : 'affiliate.activated', actor: adminId, affiliate_id: affiliateId, payload: { reason: text.slice(0, 240) } });
      return { status };
    });
  }

  async function flag(adminId, affiliateId, reason) {
    const text = String(reason || '').trim();
    if (text.length < 3) throw affiliateError('A reason is required');
    return db.runTransaction(async (tx) => {
      const affiliateSnap = await tx.get(col('affiliates').doc(affiliateId));
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      tx.update(affiliateSnap.ref, { flagged: true, flag_reason: text.slice(0, 240), updated_at: iso(now()) });
      auditTx(tx, { action: 'affiliate.flagged', actor: adminId, affiliate_id: affiliateId, payload: { reason: text.slice(0, 240) } });
      return { flagged: true };
    });
  }

  async function clearFlag(adminId, affiliateId) {
    const heldSnap = await col('affiliate_commissions').where('affiliate_id', '==', affiliateId).get();
    const held = heldSnap.docs.map((doc) => doc.data()).filter((row) => row.status === 'held' && row.hold_reason === 'affiliate_flagged');
    return db.runTransaction(async (tx) => {
      const [affiliateSnap, walletSnap, ...commissionSnaps] = await Promise.all([
        tx.get(col('affiliates').doc(affiliateId)),
        tx.get(col('affiliate_wallets').doc(affiliateId)),
        ...held.map((row) => tx.get(col('affiliate_commissions').doc(row.id))),
      ]);
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      const wallet = { ...(walletSnap.exists ? walletSnap.data() : emptyWallet(affiliateId)) };
      tx.update(affiliateSnap.ref, { flagged: false, flag_reason: null, updated_at: iso(now()) });
      for (const commissionSnap of commissionSnaps) {
        if (!commissionSnap.exists || commissionSnap.data().status !== 'held') continue;
        const amount = commissionSnap.data().amount_kobo;
        wallet.held_kobo -= amount;
        wallet.pending_kobo += amount;
        tx.update(commissionSnap.ref, {
          status: 'pending',
          hold_reason: null,
          available_at: now() + (commissionSnap.data().hold_days || 7) * DAY_MS,
          updated_at: iso(now()),
        });
      }
      tx.set(col('affiliate_wallets').doc(affiliateId), { ...wallet, updated_at: iso(now()) }, { merge: true });
      auditTx(tx, { action: 'affiliate.flag_cleared', actor: adminId, affiliate_id: affiliateId, payload: { released: held.length } });
      return { flagged: false };
    });
  }

  async function clearSuspicion(adminId, referredUserId) {
    const attributionSnap = await col('affiliate_attributions').doc(referredUserId).get();
    if (!attributionSnap.exists) throw affiliateError('Referral not found', 404);
    const affiliateId = attributionSnap.data().affiliate_id;
    const heldSnap = await col('affiliate_commissions').where('referred_user_id', '==', referredUserId).get();
    const held = heldSnap.docs.map((doc) => doc.data()).filter((row) => row.status === 'held' && row.hold_reason === 'velocity');
    return db.runTransaction(async (tx) => {
      const [currentAttribution, walletSnap, ...commissionSnaps] = await Promise.all([
        tx.get(col('affiliate_attributions').doc(referredUserId)),
        tx.get(col('affiliate_wallets').doc(affiliateId)),
        ...held.map((row) => tx.get(col('affiliate_commissions').doc(row.id))),
      ]);
      const wallet = { ...(walletSnap.exists ? walletSnap.data() : emptyWallet(affiliateId)) };
      tx.update(currentAttribution.ref, { suspicion_cleared: true, updated_at: iso(now()) });
      for (const commissionSnap of commissionSnaps) {
        if (!commissionSnap.exists || commissionSnap.data().status !== 'held') continue;
        const amount = commissionSnap.data().amount_kobo;
        wallet.held_kobo -= amount;
        wallet.pending_kobo += amount;
        tx.update(commissionSnap.ref, {
          status: 'pending',
          hold_reason: null,
          available_at: now() + (commissionSnap.data().hold_days || 7) * DAY_MS,
          updated_at: iso(now()),
        });
      }
      tx.set(col('affiliate_wallets').doc(affiliateId), { ...wallet, updated_at: iso(now()) }, { merge: true });
      auditTx(tx, { action: 'attribution.suspicion_cleared', actor: adminId, affiliate_id: affiliateId, payload: { referredUserId, released: held.length } });
      return { cleared: true };
    });
  }

  async function setFutureRate(adminId, affiliateId, rateBps) {
    if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 5000) throw affiliateError('Invalid rate');
    return db.runTransaction(async (tx) => {
      const affiliateSnap = await tx.get(col('affiliates').doc(affiliateId));
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      const before = affiliateSnap.data().rate_bps_override;
      tx.update(affiliateSnap.ref, { rate_bps_override: rateBps, updated_at: iso(now()) });
      auditTx(tx, { action: 'affiliate.rate_override', actor: adminId, affiliate_id: affiliateId, payload: { before, after: rateBps } });
      return { rateBps };
    });
  }

  async function attributeReferral({ referredUserId, code, name, email, suspicious = false }) {
    const normalized = String(code || '').trim().toUpperCase();
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(col('affiliate_attributions').doc(referredUserId));
      if (existing.exists) throw affiliateError('User already attributed');
      const profiles = await tx.get(col('users').where('referral_code', '==', normalized));
      const owner = profiles.docs[0];
      if (!owner || owner.id === referredUserId) throw affiliateError('Self-referrals are not allowed', 400, 'SELF_REFERRAL');
      const affiliateSnap = await tx.get(col('affiliates').doc(owner.id));
      if (!affiliateSnap.exists || affiliateSnap.data().status !== 'active') throw affiliateError('Affiliate is not active');
      const settingsSnap = await tx.get(col('affiliate_settings').doc(SETTINGS_DOC));
      const settings = normalizeSettings(settingsSnap.exists ? settingsSnap.data() : null);
      const record = buildSignupAttribution({
        referredUserId,
        affiliateId: owner.id,
        code: normalized,
        suspicious,
        settings,
        now: now(),
        maskedLabel: maskCustomer(name, email),
      });
      tx.create(col('affiliate_attributions').doc(referredUserId), record);
      auditTx(tx, { action: 'attribution.registered', actor: 'system', affiliate_id: owner.id, payload: { referredUserId, suspicious: Boolean(suspicious) } });
      return record;
    });
  }

  async function recordQualifyingPurchase(input) {
    const paymentTxId = String(input.paymentTxId || '').trim();
    if (!paymentTxId) throw affiliateError('paymentTxId required');
    const referredUserId = input.referredUserId;
    const dedupRef = col('affiliate_commission_dedup').doc(hash(`affiliate-commission:${paymentTxId}`));
    const existing = await dedupRef.get();
    if (existing.exists && existing.data().commission_id) {
      const commission = await col('affiliate_commissions').doc(existing.data().commission_id).get();
      return { duplicate: true, commission: commission.exists ? commissionView(commission.data()) : null, skipped: false };
    }
    if (existing.exists && existing.data().skipped) {
      return { duplicate: true, commission: null, skipped: true, reason: existing.data().reason };
    }
    const attributionPeek = referredUserId ? await col('affiliate_attributions').doc(referredUserId).get() : null;
    if (attributionPeek?.exists) await releaseDue(attributionPeek.data().affiliate_id);

    return db.runTransaction(async (tx) => {
      const seen = await tx.get(dedupRef);
      if (seen.exists && seen.data().commission_id) {
        const commission = await tx.get(col('affiliate_commissions').doc(seen.data().commission_id));
        return { duplicate: true, commission: commission.exists ? commissionView(commission.data()) : null, skipped: false };
      }
      if (seen.exists && seen.data().skipped) {
        return { duplicate: true, commission: null, skipped: true, reason: seen.data().reason };
      }
      const skip = (reason) => {
        tx.create(dedupRef, { payment_tx_id: paymentTxId, skipped: true, reason, at: now() });
        auditTx(tx, { action: 'commission.skipped', actor: 'system', payload: { paymentTxId, reason } });
        return { duplicate: false, commission: null, skipped: true, reason };
      };
      const type = input.transactionType || input.type || 'credit_purchase';
      if (type !== 'credit_purchase' || input.freeCredits || input.manualCredits || input.signupBonus) return skip('non_paid_credits');
      if (input.refunded) return skip('refunded_transaction');
      if (input.currency && input.currency !== 'NGN') return skip('currency_not_ngn');
      if (input.settlementUnverified || !Number.isSafeInteger(input.packagePriceKobo) || input.packagePriceKobo <= 0) {
        return skip('unverified_ngn_settlement');
      }
      const attributionSnap = referredUserId ? await tx.get(col('affiliate_attributions').doc(referredUserId)) : null;
      if (!attributionSnap?.exists) return skip('no_attribution');
      const attribution = { ...attributionSnap.data() };
      const [affiliateSnap, settingsSnap, walletSnap] = await Promise.all([
        tx.get(col('affiliates').doc(attribution.affiliate_id)),
        tx.get(col('affiliate_settings').doc(SETTINGS_DOC)),
        tx.get(col('affiliate_wallets').doc(attribution.affiliate_id)),
      ]);
      const settings = normalizeSettings(settingsSnap.exists ? settingsSnap.data() : null);
      if (!affiliateSnap.exists || affiliateSnap.data().status !== 'active') return skip('affiliate_not_active');
      if (!settings.commissionsEnabled) return skip('commissions_paused');
      const maxDays = attribution.max_days_before_first_purchase || settings.maxDaysBeforeFirstPurchase;
      if (attribution.status === 'expired' || attribution.status === 'expired_unactivated') {
        return skip(attribution.status === 'expired' ? 'window_expired' : 'first_purchase_window_missed');
      }
      if (attribution.status === 'registered') {
        if (now() - attribution.registered_at > maxDays * DAY_MS) {
          tx.update(attributionSnap.ref, { status: 'expired_unactivated', expired_at: now(), updated_at: iso(now()) });
          return skip('first_purchase_window_missed');
        }
        const rateBps = affiliateSnap.data().rate_bps_override ?? settings.defaultRateBps;
        attribution.status = 'active';
        attribution.first_purchase_at = now();
        attribution.first_purchase_id = paymentTxId;
        attribution.window_started_at = now();
        attribution.duration_days = settings.durationDays;
        attribution.hold_days = settings.holdDays;
        attribution.rate_bps = rateBps;
        attribution.window_ends_at = now() + settings.durationDays * DAY_MS;
        const snapId = randomUUID();
        attribution.settings_snapshot_id = snapId;
        tx.create(col('affiliate_settings_snapshots').doc(snapId), {
          id: snapId,
          at: now(),
          reason: 'window.opened',
          rules: settingsToDoc(settings),
          rate_bps: rateBps,
        });
        tx.update(attributionSnap.ref, {
          status: 'active',
          first_purchase_at: attribution.first_purchase_at,
          first_purchase_id: paymentTxId,
          window_started_at: attribution.window_started_at,
          window_ends_at: attribution.window_ends_at,
          duration_days: attribution.duration_days,
          hold_days: attribution.hold_days,
          rate_bps: rateBps,
          settings_snapshot_id: snapId,
          updated_at: iso(now()),
        });
        auditTx(tx, { action: 'attribution.activated', actor: 'system', affiliate_id: attribution.affiliate_id, payload: { referredUserId, rateBps, windowEndsAt: attribution.window_ends_at } });
      }
      if (attribution.window_ends_at && now() > attribution.window_ends_at) {
        tx.update(attributionSnap.ref, { status: 'expired', updated_at: iso(now()) });
        return skip('window_expired');
      }
      const amount = commissionKobo(input.packagePriceKobo, attribution.rate_bps);
      if (amount <= 0) return skip('zero_commission');
      const holdForVelocity = attribution.suspicious && !attribution.suspicion_cleared;
      const holdForFlag = Boolean(affiliateSnap.data().flagged);
      const held = holdForVelocity || holdForFlag;
      const commissionId = randomUUID();
      const commission = {
        id: commissionId,
        affiliate_id: attribution.affiliate_id,
        referred_user_id: referredUserId,
        payment_tx_id: paymentTxId,
        reference: input.reference || null,
        gateway: input.gateway || null,
        purchase_kobo: input.packagePriceKobo,
        rate_bps: attribution.rate_bps,
        amount_kobo: amount,
        hold_days: attribution.hold_days,
        status: held ? 'held' : 'pending',
        hold_reason: holdForVelocity ? 'velocity' : holdForFlag ? 'affiliate_flagged' : null,
        created_at: iso(now()),
        available_at: now() + attribution.hold_days * DAY_MS,
        available_released_at: null,
        reversed_at: null,
        settings_snapshot_id: attribution.settings_snapshot_id,
      };
      const wallet = { ...(walletSnap.exists ? walletSnap.data() : emptyWallet(attribution.affiliate_id)) };
      if (held) wallet.held_kobo += amount;
      else wallet.pending_kobo += amount;
      wallet.lifetime_earned_kobo += amount;
      wallet.updated_at = iso(now());
      tx.create(col('affiliate_commissions').doc(commissionId), commission);
      tx.create(dedupRef, { payment_tx_id: paymentTxId, commission_id: commissionId, skipped: false, at: now() });
      tx.set(col('affiliate_wallets').doc(attribution.affiliate_id), wallet, { merge: true });
      tx.update(attributionSnap.ref, {
        purchase_count: (attribution.purchase_count || 0) + 1,
        earned_kobo: (attribution.earned_kobo || 0) + amount,
        updated_at: iso(now()),
      });
      ledgerTx(tx, {
        affiliate_id: attribution.affiliate_id,
        type: held ? 'commission_held' : 'commission_pending',
        amount_kobo: amount,
        commission_id: commissionId,
        payment_tx_id: paymentTxId,
      });
      auditTx(tx, { action: 'commission.created', actor: 'system', affiliate_id: attribution.affiliate_id, payload: { commissionId, paymentTxId, amountKobo: amount, held } });
      return { duplicate: false, commission: commissionView(commission), skipped: false };
    });
  }

  async function refundPayment({ paymentTxId, reference, adminId, reason }) {
    const text = String(reason || 'payment_refunded').trim();
    if (text.length < 3) throw affiliateError('A reason is required');
    let resolvedId = String(paymentTxId || '').trim();
    if (!resolvedId && reference) {
      const found = await col('affiliate_commissions').where('reference', '==', String(reference)).get();
      if (found.size !== 1) return { reversed: false, reason: 'no_commission' };
      resolvedId = found.docs[0].data().payment_tx_id;
    }
    if (!resolvedId) return { reversed: false, reason: 'no_commission' };
    const dedupRef = col('affiliate_commission_dedup').doc(hash(`affiliate-commission:${resolvedId}`));
    const dedup = await dedupRef.get();
    if (!dedup.exists || !dedup.data().commission_id) return { reversed: false, reason: 'no_commission' };
    const commissionId = dedup.data().commission_id;
    return db.runTransaction(async (tx) => {
      const commissionSnap = await tx.get(col('affiliate_commissions').doc(commissionId));
      if (!commissionSnap.exists) return { reversed: false, reason: 'no_commission' };
      const commission = commissionSnap.data();
      if (commission.status === 'reversed') return { reversed: true, duplicate: true, commission: commissionView(commission) };
      const walletSnap = await tx.get(col('affiliate_wallets').doc(commission.affiliate_id));
      const attributionSnap = await tx.get(col('affiliate_attributions').doc(commission.referred_user_id));
      const wallet = { ...(walletSnap.exists ? walletSnap.data() : emptyWallet(commission.affiliate_id)) };
      const amount = commission.amount_kobo;
      const previousStatus = commission.status;
      if (previousStatus === 'pending') wallet.pending_kobo -= amount;
      else if (previousStatus === 'held') wallet.held_kobo -= amount;
      else if (previousStatus === 'available') {
        if (wallet.available_kobo >= amount) wallet.available_kobo -= amount;
        else {
          const shortfall = amount - wallet.available_kobo;
          wallet.available_kobo = 0;
          wallet.clawback_due_kobo += shortfall;
        }
      } else wallet.clawback_due_kobo += amount;
      wallet.lifetime_reversed_kobo += amount;
      wallet.lifetime_earned_kobo = Math.max(0, wallet.lifetime_earned_kobo - amount);
      wallet.updated_at = iso(now());
      tx.update(commissionSnap.ref, { status: 'reversed', reversed_at: now(), reversal_reason: text.slice(0, 240), updated_at: iso(now()) });
      tx.set(walletSnap.ref, wallet, { merge: true });
      if (attributionSnap.exists) {
        tx.update(attributionSnap.ref, {
          earned_kobo: Math.max(0, (attributionSnap.data().earned_kobo || 0) - amount),
          updated_at: iso(now()),
        });
      }
      ledgerTx(tx, {
        affiliate_id: commission.affiliate_id,
        type: 'commission_reversed',
        amount_kobo: -amount,
        commission_id: commission.id,
        payment_tx_id: resolvedId,
        previous_status: previousStatus,
      });
      auditTx(tx, {
        action: 'commission.reversed',
        actor: adminId || 'system',
        affiliate_id: commission.affiliate_id,
        payload: { commissionId: commission.id, paymentTxId: resolvedId, previousStatus, reason: text.slice(0, 240) },
      });
      return {
        reversed: true,
        duplicate: false,
        previousStatus,
        commission: commissionView({ ...commission, status: 'reversed' }),
        wallet: walletView(wallet),
        customerCreditsUnchanged: true,
      };
    });
  }

  async function saveBankAccount({ userId, bankCode, accountNumber, accountName, authTime }) {
    assertRecentAuth(authTime, now());
    const code = String(bankCode || '').trim();
    if (!/^\d{3,6}$/.test(code)) throw affiliateError('Choose a Nigerian bank from the list');
    if (!isNuban(accountNumber)) throw affiliateError('Account number must be a 10-digit NUBAN');
    const name = assertAccountName(accountName);
    return db.runTransaction(async (tx) => {
      const [affiliateSnap, banks, overrideSnap] = await Promise.all([
        tx.get(col('affiliates').doc(userId)),
        tx.get(col('affiliate_bank_accounts').where('affiliate_id', '==', userId)),
        tx.get(col('affiliate_banks').doc(code)),
      ]);
      const bank = selectableBank(code, overrideSnap.exists ? [bankOverrideFromDoc(overrideSnap)] : []);
      if (!bank) throw affiliateError('Choose a Nigerian bank from the list');
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      for (const doc of banks.docs) {
        if (doc.data().active) tx.update(doc.ref, { active: false, updated_at: iso(now()) });
      }
      const id = randomUUID();
      const record = {
        id,
        affiliate_id: userId,
        bank_code: bank.code,
        bank_name: bank.name,
        account_number: String(accountNumber).trim(),
        account_name: name,
        verified: false,
        active: true,
        created_at: iso(now()),
        updated_at: iso(now()),
      };
      tx.create(col('affiliate_bank_accounts').doc(id), record);
      auditTx(tx, { action: 'bank.saved', actor: userId, affiliate_id: userId, payload: { bankId: id, bankCode: bank.code } });
      return presentBank(record, { reveal: false });
    });
  }

  async function verifyBankAccount(adminId, bankId) {
    return db.runTransaction(async (tx) => {
      const bankSnap = await tx.get(col('affiliate_bank_accounts').doc(bankId));
      if (!bankSnap.exists) throw affiliateError('Bank account not found', 404);
      tx.update(bankSnap.ref, { verified: true, verified_at: iso(now()), verified_by: adminId, updated_at: iso(now()) });
      auditTx(tx, { action: 'bank.verified', actor: adminId, affiliate_id: bankSnap.data().affiliate_id, payload: { bankId } });
      return { verified: true, bankId };
    });
  }

  async function requestWithdrawal({ userId, amountKobo, authTime }) {
    assertRecentAuth(authTime, now());
    const amount = requireKobo(amountKobo, 'Withdrawal amount');
    if (amount <= 0) throw affiliateError('Invalid withdrawal amount');
    await releaseDue(userId);
    return db.runTransaction(async (tx) => {
      const [affiliateSnap, walletSnap, settingsSnap] = await Promise.all([
        tx.get(col('affiliates').doc(userId)),
        tx.get(col('affiliate_wallets').doc(userId)),
        tx.get(col('affiliate_settings').doc(SETTINGS_DOC)),
      ]);
      const bank = await activeBank(tx, userId);
      if (!affiliateSnap.exists || affiliateSnap.data().status !== 'active') throw affiliateError('Affiliate is not active', 403);
      const settings = normalizeSettings(settingsSnap.exists ? settingsSnap.data() : null);
      if (amount < settings.minWithdrawalKobo) throw affiliateError('Below minimum withdrawal');
      const wallet = { ...(walletSnap.exists ? walletSnap.data() : emptyWallet(userId)) };
      if (amount > wallet.available_kobo) throw affiliateError('Amount exceeds available balance');
      if (!bank?.verified) throw affiliateError('A verified bank account is required');
      const fee = settings.transferFeePayer === 'affiliate' ? settings.estimatedTransferFeeKobo : 0;
      if (fee < 0 || fee >= amount) throw affiliateError('Transfer fee leaves nothing to send');
      const id = randomUUID();
      const withdrawal = {
        id,
        affiliate_id: userId,
        affiliate_name: affiliateSnap.data().name || '',
        amount_kobo: amount,
        fee_kobo: fee,
        net_kobo: netPayoutKobo(amount, fee, settings.transferFeePayer),
        transfer_fee_payer: settings.transferFeePayer,
        bank_id: bank.id,
        bank_snapshot: {
          bank_code: bank.bank_code,
          bank_name: bank.bank_name,
          account_number: bank.account_number,
          account_name: bank.account_name,
          verified: true,
        },
        status: 'pending',
        manual_payout: true,
        reserve_released: false,
        created_at: iso(now()),
        updated_at: iso(now()),
        transfer_ref: null,
      };
      wallet.available_kobo -= amount;
      wallet.reserved_kobo += amount;
      wallet.updated_at = iso(now());
      tx.create(col('affiliate_withdrawals').doc(id), withdrawal);
      tx.set(walletSnap.ref, wallet, { merge: true });
      ledgerTx(tx, { affiliate_id: userId, type: 'withdrawal_reserved', amount_kobo: -amount, withdrawal_id: id });
      auditTx(tx, { action: 'withdrawal.requested', actor: userId, affiliate_id: userId, payload: { withdrawalId: id, amountKobo: amount, netKobo: withdrawal.net_kobo } });
      return withdrawalView(withdrawal, { reveal: false });
    });
  }

  async function mustWithdrawal(tx, withdrawalId) {
    const snap = await tx.get(col('affiliate_withdrawals').doc(withdrawalId));
    if (!snap.exists) throw affiliateError('Withdrawal not found', 404);
    return snap;
  }

  function releaseReserve(tx, withdrawal, wallet, actor, type, reason) {
    if (withdrawal.reserve_released) return false;
    wallet.reserved_kobo -= withdrawal.amount_kobo;
    wallet.available_kobo += withdrawal.amount_kobo;
    withdrawal.reserve_released = true;
    ledgerTx(tx, { affiliate_id: withdrawal.affiliate_id, type, amount_kobo: withdrawal.amount_kobo, withdrawal_id: withdrawal.id });
    auditTx(tx, { action: type, actor, affiliate_id: withdrawal.affiliate_id, payload: { withdrawalId: withdrawal.id, reason: reason || null } });
    return true;
  }

  async function decideWithdrawal(adminId, withdrawalId, decision, extra = {}) {
    return db.runTransaction(async (tx) => {
      const snap = await mustWithdrawal(tx, withdrawalId);
      const withdrawal = { ...snap.data() };
      const walletSnap = await tx.get(col('affiliate_wallets').doc(withdrawal.affiliate_id));
      const wallet = { ...(walletSnap.data() || emptyWallet(withdrawal.affiliate_id)) };
      if (decision === 'approve') {
        if (withdrawal.status !== 'pending') throw affiliateError('Only pending withdrawals can be approved');
        withdrawal.status = 'approved';
        withdrawal.approved_at = iso(now());
        auditTx(tx, { action: 'withdrawal.approved', actor: adminId, affiliate_id: withdrawal.affiliate_id, payload: { withdrawalId } });
      } else if (decision === 'processing') {
        if (withdrawal.status !== 'approved') throw affiliateError('Only approved withdrawals can be processed');
        withdrawal.status = 'processing';
        withdrawal.processed_at = iso(now());
        auditTx(tx, { action: 'withdrawal.processing', actor: adminId, affiliate_id: withdrawal.affiliate_id, payload: { withdrawalId } });
      } else if (decision === 'transfer') {
        if (withdrawal.status !== 'approved' && withdrawal.status !== 'processing') throw affiliateError('Transfer can only be recorded after approval');
        withdrawal.transfer_ref = assertTransferRef(extra.transferRef);
        if (withdrawal.status === 'approved') withdrawal.status = 'processing';
        withdrawal.processed_at = withdrawal.processed_at || iso(now());
        auditTx(tx, { action: 'withdrawal.transfer_recorded', actor: adminId, affiliate_id: withdrawal.affiliate_id, payload: { withdrawalId, transferRef: withdrawal.transfer_ref } });
      } else if (decision === 'paid') {
        if (withdrawal.status === 'paid') return { duplicate: true, withdrawal: withdrawalView(withdrawal, { reveal: true }) };
        if (withdrawal.status !== 'approved' && withdrawal.status !== 'processing') throw affiliateError('Withdrawal is not payable');
        if (extra.transferRef) withdrawal.transfer_ref = assertTransferRef(extra.transferRef);
        if (!withdrawal.transfer_ref) throw affiliateError('A bank transfer reference is required before marking Paid');
        if (withdrawal.reserve_released) throw affiliateError('Reserve already released');
        wallet.reserved_kobo -= withdrawal.amount_kobo;
        wallet.withdrawn_kobo += withdrawal.amount_kobo;
        withdrawal.reserve_released = true;
        withdrawal.status = 'paid';
        withdrawal.paid_at = iso(now());
        ledgerTx(tx, { affiliate_id: withdrawal.affiliate_id, type: 'withdrawal_paid', amount_kobo: -withdrawal.amount_kobo, withdrawal_id: withdrawal.id, transfer_ref: withdrawal.transfer_ref });
        auditTx(tx, { action: 'withdrawal.paid', actor: adminId, affiliate_id: withdrawal.affiliate_id, payload: { withdrawalId, transferRef: withdrawal.transfer_ref, netKobo: withdrawal.net_kobo } });
      } else if (decision === 'reject' || decision === 'fail') {
        const terminal = decision === 'reject' ? 'rejected' : 'failed';
        if (withdrawal.status === terminal) return { duplicate: true, withdrawal: withdrawalView(withdrawal, { reveal: true }) };
        if (decision === 'reject' && withdrawal.status !== 'pending' && withdrawal.status !== 'approved') throw affiliateError('Cannot reject this withdrawal');
        if (decision === 'fail' && withdrawal.status !== 'processing' && withdrawal.status !== 'approved') throw affiliateError('Cannot fail this withdrawal');
        withdrawal.status = terminal;
        withdrawal.failure_reason = String(extra.reason || terminal).slice(0, 240);
        releaseReserve(tx, withdrawal, wallet, adminId, 'withdrawal_released', withdrawal.failure_reason);
        auditTx(tx, { action: decision === 'reject' ? 'withdrawal.rejected' : 'withdrawal.failed', actor: adminId, affiliate_id: withdrawal.affiliate_id, payload: { withdrawalId, reason: withdrawal.failure_reason } });
      } else throw affiliateError('Unsupported withdrawal decision');
      withdrawal.decided_by = adminId;
      withdrawal.updated_at = iso(now());
      wallet.updated_at = iso(now());
      tx.set(snap.ref, withdrawal);
      tx.set(walletSnap.ref, wallet, { merge: true });
      return { duplicate: false, withdrawal: withdrawalView(withdrawal, { reveal: true }) };
    });
  }

  async function updateSettings(adminId, patch, { superAdmin = false } = {}) {
    if (!superAdmin) throw affiliateError('Super admin required', 403);
    const next = validateSettingsPatch({ ...(await readSettings()), ...patch, autoPayoutsEnabled: false });
    const snapId = randomUUID();
    await db.runTransaction(async (tx) => {
      const beforeSnap = await tx.get(col('affiliate_settings').doc(SETTINGS_DOC));
      const before = normalizeSettings(beforeSnap.exists ? beforeSnap.data() : null);
      tx.set(col('affiliate_settings').doc(SETTINGS_DOC), settingsToDoc(next, { updated_at: iso(now()), updated_by: adminId }));
      tx.create(col('affiliate_settings_snapshots').doc(snapId), {
        id: snapId,
        at: now(),
        reason: 'settings.updated',
        actor: adminId,
        rules: settingsToDoc(next),
      });
      auditTx(tx, { action: 'settings.updated', actor: adminId, payload: { before, after: next, snapshotId: snapId } });
    });
    return { settings: { ...next, autoPayoutsAvailable: false }, snapshotId: snapId };
  }

  function requireSuperAdmin(superAdmin) {
    if (!superAdmin) throw affiliateError('Super admin required', 403);
  }

  async function listBanks() {
    return effectiveBanks(await readBankOverrides()).map(presentCatalogBank);
  }

  async function addBank(adminId, input, { superAdmin = false } = {}) {
    requireSuperAdmin(superAdmin);
    const code = normalizeBankCode(input?.code);
    const name = normalizeBankName(input?.name);
    return db.runTransaction(async (tx) => {
      const ref = col('affiliate_banks').doc(code);
      const existing = await tx.get(ref);
      if (existing.exists || bankByCode(code)) {
        throw affiliateError('A bank with that code already exists');
      }
      const record = {
        code,
        name,
        enabled: true,
        created_at: iso(now()),
        updated_at: iso(now()),
        updated_by: adminId,
      };
      tx.create(ref, record);
      auditTx(tx, { action: 'bank.added', actor: adminId, payload: { code, name } });
      return { bank: presentCatalogBank({ ...record, builtin: false }) };
    });
  }

  async function updateBank(adminId, input, { superAdmin = false } = {}) {
    requireSuperAdmin(superAdmin);
    const code = normalizeBankCode(input?.code);
    const hasName = input?.name !== undefined;
    const hasEnabled = input?.enabled !== undefined;
    if (!hasName && !hasEnabled) throw affiliateError('Nothing to update');
    if (hasEnabled && typeof input.enabled !== 'boolean') {
      throw affiliateError('Enabled must be true or false');
    }
    const nextName = hasName ? normalizeBankName(input.name) : undefined;
    const nextEnabled = hasEnabled ? input.enabled : undefined;
    const builtin = bankByCode(code);
    return db.runTransaction(async (tx) => {
      const ref = col('affiliate_banks').doc(code);
      const existing = await tx.get(ref);
      if (!existing.exists && !builtin) throw affiliateError('Bank not found', 404);
      const current = existing.exists ? existing.data() : {};
      const currentName = String(current.name || builtin?.name || '');
      const currentEnabled = existing.exists ? current.enabled !== false : true;
      const name = nextName === undefined ? currentName : nextName;
      const enabled = nextEnabled === undefined ? currentEnabled : nextEnabled;
      const bank = presentCatalogBank({
        code,
        name,
        enabled,
        builtin: Boolean(builtin),
        created_at: current.created_at || null,
        updated_at: current.updated_at || null,
        updated_by: current.updated_by || null,
      });
      if (name === currentName && enabled === currentEnabled) return { bank };
      const record = {
        code,
        name,
        enabled,
        created_at: current.created_at || iso(now()),
        updated_at: iso(now()),
        updated_by: adminId,
      };
      tx.set(ref, record);
      auditTx(tx, {
        action: 'bank.updated',
        actor: adminId,
        payload: { code, before: { name: currentName, enabled: currentEnabled }, after: { name, enabled } },
      });
      return { bank: presentCatalogBank({ ...record, builtin: Boolean(builtin) }) };
    });
  }

  async function adjustWallet(adminId, affiliateId, amountKobo, reason, { superAdmin = false } = {}) {
    if (!superAdmin) throw affiliateError('Super admin required', 403);
    const text = String(reason || '').trim();
    if (text.length < 3) throw affiliateError('A reason is required');
    const amount = requireKobo(amountKobo, 'Adjustment');
    if (amount === 0) throw affiliateError('Invalid adjustment');
    return db.runTransaction(async (tx) => {
      const affiliateSnap = await tx.get(col('affiliates').doc(affiliateId));
      if (!affiliateSnap.exists) throw affiliateError('Affiliate not found', 404);
      const walletSnap = await tx.get(col('affiliate_wallets').doc(affiliateId));
      const wallet = { ...(walletSnap.exists ? walletSnap.data() : emptyWallet(affiliateId)) };
      wallet.available_kobo += amount;
      if (wallet.available_kobo < 0) {
        wallet.clawback_due_kobo += -wallet.available_kobo;
        wallet.available_kobo = 0;
      }
      wallet.updated_at = iso(now());
      tx.set(col('affiliate_wallets').doc(affiliateId), wallet, { merge: true });
      ledgerTx(tx, { affiliate_id: affiliateId, type: 'admin_adjustment', amount_kobo: amount, reason: text.slice(0, 240), actor: adminId });
      auditTx(tx, { action: 'wallet.adjusted', actor: adminId, affiliate_id: affiliateId, payload: { amountKobo: amount, reason: text.slice(0, 240) } });
      return walletView(wallet);
    });
  }

  async function listAffiliates(search = '') {
    const snap = await col('affiliates').get();
    const needle = String(search || '').trim().toLowerCase();
    return snap.docs
      .map((doc) => doc.data())
      .filter((row) => !needle || `${row.name} ${row.email} ${row.code || ''} ${row.user_id}`.toLowerCase().includes(needle))
      .slice(0, 200)
      .map((row) => ({
        id: row.user_id,
        name: row.name,
        email: row.email,
        status: row.status,
        code: row.code,
        link: row.link,
        rateBpsOverride: row.rate_bps_override,
        flagged: Boolean(row.flagged),
        flagReason: row.flag_reason || null,
        createdAt: row.created_at,
      }));
  }

  async function listCommissions() {
    const snap = await col('affiliate_commissions').get();
    return snap.docs.map((doc) => {
      const row = doc.data();
      return {
        ...commissionView(row),
        affiliateId: row.affiliate_id,
        maskedCustomer: row.referred_user_id ? row.referred_user_id.slice(0, 4) + '***' : 'C***',
      };
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 500);
  }

  async function listWithdrawals({ adminId, reveal = false, status, search, auditAction = 'withdrawal.queue_viewed' } = {}) {
    const snap = await col('affiliate_withdrawals').get();
    let rows = snap.docs.map((doc) => doc.data());
    if (status && status !== 'all') rows = rows.filter((row) => row.status === status);
    if (search) {
      const needle = String(search).trim().toLowerCase();
      rows = rows.filter((row) => `${row.affiliate_name} ${row.affiliate_id} ${row.id}`.toLowerCase().includes(needle));
    }
    rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    rows = rows.slice(0, 300);
    if (reveal) {
      await writeAudit({
        action: auditAction,
        actor: adminId,
        payload: { withdrawalIds: rows.map((row) => row.id), count: rows.length, bankDetailsRevealed: true },
      });
    }
    return rows.map((row) => withdrawalView(row, { reveal }));
  }

  function withdrawalsCsv(rows) {
    const header = ['Withdrawal', 'Affiliate', 'Status', 'Amount kobo', 'Fee kobo', 'Net kobo', 'Bank', 'Account number', 'Account name', 'Transfer reference', 'Requested'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of rows) {
      lines.push([
        row.id,
        row.affiliateName || row.affiliateId,
        row.status,
        row.amountKobo,
        row.feeKobo,
        row.netKobo,
        row.bank?.bankName || '',
        row.bank?.accountNumber || '',
        row.bank?.accountName || '',
        row.transferRef || '',
        row.createdAt,
      ].map(csvCell).join(','));
    }
    return lines.join('\n');
  }

  async function analytics({ preset = '30d', from, to } = {}) {
    const end = to ? Date.parse(to) : now();
    let start = now() - 30 * DAY_MS;
    if (preset === 'today') start = new Date(new Date(now()).toISOString().slice(0, 10)).getTime();
    else if (preset === '7d') start = now() - 7 * DAY_MS;
    else if (preset === 'custom' && from) start = Date.parse(from);
    const [commissionsSnap, attributionsSnap, affiliatesSnap] = await Promise.all([
      col('affiliate_commissions').get(),
      col('affiliate_attributions').get(),
      col('affiliates').get(),
    ]);
    const commissions = commissionsSnap.docs.map((doc) => doc.data()).filter((row) => {
      const at = Date.parse(row.created_at);
      return at >= start && at <= end && row.status !== 'reversed';
    });
    const revenue = commissions.reduce((sum, row) => sum + row.purchase_kobo, 0);
    const commissionTotal = commissions.reduce((sum, row) => sum + row.amount_kobo, 0);
    const byCustomer = new Map();
    for (const row of commissions) {
      const list = byCustomer.get(row.referred_user_id) || [];
      list.push(row);
      byCustomer.set(row.referred_user_id, list);
    }
    let returningPurchases = 0;
    let newPurchases = 0;
    for (const list of byCustomer.values()) {
      list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      newPurchases += 1;
      returningPurchases += Math.max(0, list.length - 1);
    }
    const names = new Map(affiliatesSnap.docs.map((doc) => [doc.id, doc.data().name]));
    const byAffiliate = new Map();
    for (const row of commissions) {
      const current = byAffiliate.get(row.affiliate_id) || { affiliateId: row.affiliate_id, name: names.get(row.affiliate_id) || 'Affiliate', revenueKobo: 0, commissionKobo: 0, customers: new Set() };
      current.revenueKobo += row.purchase_kobo;
      current.commissionKobo += row.amount_kobo;
      current.customers.add(row.referred_user_id);
      byAffiliate.set(row.affiliate_id, current);
    }
    const ranked = [...byAffiliate.values()].map((row) => ({ ...row, payingCustomers: row.customers.size, customers: undefined }));
    const attributions = attributionsSnap.docs.map((doc) => doc.data()).filter((row) => row.registered_at >= start && row.registered_at <= end);
    const paying = attributions.filter((row) => (row.purchase_count || 0) > 0).length;
    const buckets = new Map();
    for (const row of commissions) {
      const day = row.created_at.slice(0, 10);
      const bucket = buckets.get(day) || { day, revenueKobo: 0, commissionKobo: 0 };
      bucket.revenueKobo += row.purchase_kobo;
      bucket.commissionKobo += row.amount_kobo;
      buckets.set(day, bucket);
    }
    return {
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      attributedRevenueKobo: revenue,
      commissionKobo: commissionTotal,
      commissionPercentOfRevenue: revenue ? commissionTotal / revenue : 0,
      averagePurchaseKobo: commissions.length ? Math.round(revenue / commissions.length) : 0,
      newPurchases,
      returningPurchases,
      conversionRate: attributions.length ? paying / attributions.length : 0,
      registrations: attributions.length,
      payingCustomers: paying,
      series: [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)),
      topByRevenue: ranked.sort((a, b) => b.revenueKobo - a.revenueKobo).slice(0, 10),
      topByCustomers: ranked.sort((a, b) => b.payingCustomers - a.payingCustomers).slice(0, 10),
    };
  }

  async function overview() {
    const [affiliatesSnap, commissionsSnap, withdrawalsSnap, walletsSnap] = await Promise.all([
      col('affiliates').get(),
      col('affiliate_commissions').get(),
      col('affiliate_withdrawals').get(),
      col('affiliate_wallets').get(),
    ]);
    const affiliates = affiliatesSnap.docs.map((doc) => doc.data());
    const commissions = commissionsSnap.docs.map((doc) => doc.data()).filter((row) => row.status !== 'reversed');
    const withdrawals = withdrawalsSnap.docs.map((doc) => doc.data());
    const wallets = walletsSnap.docs.map((doc) => doc.data());
    return {
      affiliates: affiliates.length,
      pendingApplications: affiliates.filter((row) => row.status === 'pending').length,
      activeAffiliates: affiliates.filter((row) => row.status === 'active').length,
      attributedRevenueKobo: commissions.reduce((sum, row) => sum + row.purchase_kobo, 0),
      commissionKobo: commissions.reduce((sum, row) => sum + row.amount_kobo, 0),
      pendingPayouts: withdrawals.filter((row) => row.status === 'pending' || row.status === 'approved' || row.status === 'processing').length,
      availableKobo: wallets.reduce((sum, row) => sum + (row.available_kobo || 0), 0),
      reservedKobo: wallets.reduce((sum, row) => sum + (row.reserved_kobo || 0), 0),
      manualPayouts: true,
      autoPayoutsAvailable: false,
    };
  }

  async function listAudit() {
    const snap = await col('affiliate_audit').get();
    return snap.docs.map((doc) => doc.data()).sort((a, b) => b.at - a.at).slice(0, 200).map((row) => ({
      id: row.id,
      at: row.created_at,
      action: row.action,
      actor: row.actor,
      affiliateId: row.affiliate_id || null,
      payload: row.payload || {},
    }));
  }

  async function reconcile() {
    const snap = await col('affiliate_reconcile').where('status', '==', 'pending').get();
    let retried = 0;
    let failed = 0;
    for (const doc of snap.docs) {
      const row = doc.data();
      try {
        await recordQualifyingPurchase({
          referredUserId: row.user_id,
          paymentTxId: `${row.gateway}:${row.gateway_id}`,
          gateway: row.gateway,
          reference: row.reference,
          packagePriceKobo: row.package_price_kobo,
          transactionType: row.transaction_type || 'credit_purchase',
          currency: row.currency || 'NGN',
          settlementUnverified: row.settlement_unverified === true,
          refunded: row.refunded === true,
        });
        await doc.ref.set({ status: 'done', updated_at: iso(now()) }, { merge: true });
        retried += 1;
      } catch {
        failed += 1;
      }
    }
    return { retried, failed, examined: snap.size };
  }

  return {
    DAY_MS,
    formatNgn,
    readSettings,
    dashboard,
    apply,
    approve,
    reject,
    setStatus,
    flag,
    clearFlag,
    clearSuspicion,
    setFutureRate,
    attributeReferral,
    recordQualifyingPurchase,
    refundPayment,
    saveBankAccount,
    verifyBankAccount,
    requestWithdrawal,
    decideWithdrawal,
    updateSettings,
    listBanks,
    addBank,
    updateBank,
    adjustWallet,
    listAffiliates,
    listCommissions,
    listWithdrawals,
    withdrawalsCsv,
    analytics,
    overview,
    listAudit,
    releaseDue,
    reconcile,
    statsFor: async (affiliateId) => {
      const view = await dashboard(affiliateId);
      const state = {
        wallet: {
          availableKobo: view.wallet.availableKobo,
          pendingKobo: view.wallet.pendingKobo,
          heldKobo: view.wallet.heldKobo,
          reservedKobo: view.wallet.reservedKobo,
          lifetimeEarnedKobo: view.wallet.lifetimeEarnedKobo,
          lifetimeReversedKobo: view.wallet.lifetimeReversedKobo,
          withdrawnKobo: view.wallet.withdrawnKobo,
          clawbackDueKobo: view.wallet.clawbackDueKobo,
        },
        payingReferrals: view.stats.payingReferrals,
        commissions: view.commissions,
      };
      return state;
    },
  };
}

export async function resolveBankAccountWithProvider() {
  return { implemented: false, verified: false, provider: 'flutterwave' };
}
