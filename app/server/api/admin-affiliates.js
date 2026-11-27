// @ts-nocheck
import { requireAdminContext } from '../../../shared/admin-auth.js';
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { firebaseDb } from '../firebase-admin.js';
import { createAffiliateService } from '../affiliate-service.mjs';
import { assertAffiliateOrigin, assertJsonPost } from '../affiliate-http.mjs';

function send(res, status, body) {
  res.status(status).json(body);
}

export function createAdminAffiliateHandler({ supabaseAdmin: admin, db }) {
  const service = () => createAffiliateService(db);
  return async function adminAffiliateHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' });
    if (!admin || !db) return send(res, 503, { error: supabaseAdminConfigError || 'Affiliate admin is not configured' });
    try {
      assertAffiliateOrigin(req);
      assertJsonPost(req);
    } catch (error) {
      return send(res, error.status || 403, { error: 'Admin access required' });
    }
    const context = await requireAdminContext(req, res, admin);
    if (!context) return;
    const adminId = context.user.id;
    const superAdmin = context.admin.role === 'super_admin';
    const action = String(req.body?.action || req.query?.view || 'overview').trim();
    try {
      const api = service();
      if (req.method === 'GET' && (action === 'overview' || action === 'summary')) {
        return res.json({ role: context.admin.role, ...(await api.overview()), manualPayouts: true, autoPayoutsAvailable: false });
      }
      if (action === 'affiliates') return res.json({ role: context.admin.role, affiliates: await api.listAffiliates(req.query?.q || req.body?.q || '') });
      if (action === 'commissions') return res.json({ role: context.admin.role, commissions: await api.listCommissions() });
      if (action === 'withdrawals') {
        const rows = await api.listWithdrawals({
          adminId,
          reveal: true,
          status: req.query?.status || req.body?.status || 'all',
          search: req.query?.q || req.body?.q || '',
        });
        return res.json({ role: context.admin.role, manualPayouts: true, autoPayoutsAvailable: false, withdrawals: rows });
      }
      if (action === 'withdrawals-csv') {
        const rows = await api.listWithdrawals({
          adminId,
          reveal: true,
          status: req.query?.status || 'all',
          search: req.query?.q || '',
          auditAction: 'withdrawal.csv_exported',
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="morphly-affiliate-withdrawals.csv"');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.statusCode = 200;
        return res.end(api.withdrawalsCsv(rows));
      }
      if (action === 'analytics') {
        return res.json({ role: context.admin.role, ...(await api.analytics({ preset: req.query?.preset || req.body?.preset || '30d', from: req.query?.from || req.body?.from, to: req.query?.to || req.body?.to })) });
      }
      if (action === 'settings' && req.method === 'GET') {
        return res.json({ role: context.admin.role, settings: await api.readSettings(), autoPayoutsAvailable: false });
      }
      if (action === 'banks' && req.method === 'GET') {
        return res.json({ role: context.admin.role, banks: await api.listBanks() });
      }
      if (action === 'audit') return res.json({ role: context.admin.role, audit: await api.listAudit() });
      if (req.method !== 'POST') return send(res, 404, { error: 'Admin route not found' });
      if (action === 'approve') return res.json(await api.approve(adminId, String(req.body?.affiliateId || '')));
      if (action === 'reject') return res.json(await api.reject(adminId, String(req.body?.affiliateId || ''), req.body?.reason));
      if (action === 'suspend' || action === 'activate') {
        return res.json(await api.setStatus(adminId, String(req.body?.affiliateId || ''), action === 'suspend' ? 'suspended' : 'active', req.body?.reason));
      }
      if (action === 'flag') return res.json(await api.flag(adminId, String(req.body?.affiliateId || ''), req.body?.reason));
      if (action === 'clear-flag') return res.json(await api.clearFlag(adminId, String(req.body?.affiliateId || '')));
      if (action === 'clear-suspicion') return res.json(await api.clearSuspicion(adminId, String(req.body?.referredUserId || '')));
      if (action === 'rate') {
        if (!superAdmin) return send(res, 403, { error: 'Super admin required' });
        return res.json(await api.setFutureRate(adminId, String(req.body?.affiliateId || ''), req.body?.rateBps));
      }
      if (action === 'verify-bank') return res.json(await api.verifyBankAccount(adminId, String(req.body?.bankId || '')));
      if (action === 'refund') return res.json(await api.refundPayment({ paymentTxId: req.body?.paymentTxId, reference: req.body?.reference, adminId, reason: req.body?.reason }));
      if (action === 'adjust') return res.json(await api.adjustWallet(adminId, String(req.body?.affiliateId || ''), req.body?.amountKobo, req.body?.reason, { superAdmin }));
      if (action === 'settings') return res.json(await api.updateSettings(adminId, req.body?.settings || req.body || {}, { superAdmin }));
      if (action === 'bank-add') {
        return res.json(await api.addBank(adminId, { code: req.body?.code, name: req.body?.name }, { superAdmin }));
      }
      if (action === 'bank-update') {
        return res.json(await api.updateBank(adminId, {
          code: req.body?.code,
          name: req.body?.name,
          enabled: req.body?.enabled,
        }, { superAdmin }));
      }
      if (action === 'withdrawal-approve') return res.json(await api.decideWithdrawal(adminId, String(req.body?.withdrawalId || ''), 'approve'));
      if (action === 'withdrawal-processing') return res.json(await api.decideWithdrawal(adminId, String(req.body?.withdrawalId || ''), 'processing'));
      if (action === 'withdrawal-transfer') return res.json(await api.decideWithdrawal(adminId, String(req.body?.withdrawalId || ''), 'transfer', { transferRef: req.body?.transferRef }));
      if (action === 'withdrawal-paid') return res.json(await api.decideWithdrawal(adminId, String(req.body?.withdrawalId || ''), 'paid', { transferRef: req.body?.transferRef }));
      if (action === 'withdrawal-reject') return res.json(await api.decideWithdrawal(adminId, String(req.body?.withdrawalId || ''), 'reject', { reason: req.body?.reason }));
      if (action === 'withdrawal-fail') return res.json(await api.decideWithdrawal(adminId, String(req.body?.withdrawalId || ''), 'fail', { reason: req.body?.reason }));
      return send(res, 404, { error: 'Admin route not found' });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        try { console.error('[affiliate-admin] request failed'); } catch { /* ignore */ }
      }
      return send(res, status, { error: status >= 500 ? 'Unable to complete that request' : error.message });
    }
  };
}

export const ADMIN_AFFILIATE_ACTIONS = [
  'overview', 'affiliates', 'commissions', 'withdrawals', 'withdrawals-csv', 'analytics', 'settings', 'banks', 'audit',
  'approve', 'reject', 'suspend', 'activate', 'flag', 'clear-flag', 'clear-suspicion', 'rate', 'verify-bank',
  'refund', 'adjust', 'bank-add', 'bank-update', 'withdrawal-approve', 'withdrawal-processing', 'withdrawal-transfer',
  'withdrawal-paid', 'withdrawal-reject', 'withdrawal-fail',
];

export default createAdminAffiliateHandler({ supabaseAdmin, db: firebaseDb });
