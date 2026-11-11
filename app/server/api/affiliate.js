// @ts-nocheck
import { authenticateRequestUser, extractBearerToken } from '../../../shared/admin-auth.js';
import { affiliateError } from '../../../shared/affiliate-program.mjs';
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { firebaseDb } from '../firebase-admin.js';
import { createAffiliateService } from '../affiliate-service.mjs';
import { assertAffiliateOrigin, assertCaller, assertJsonPost, consumeRateLimit } from '../affiliate-http.mjs';

function send(res, status, body) {
  res.status(status).json(body);
}

async function recentAuthTime(req, auth) {
  const token = extractBearerToken(req);
  if (!token || typeof auth?.verifyIdToken !== 'function') {
    throw affiliateError('Re-authentication required', 403, 'REAUTH_REQUIRED');
  }
  const decoded = await auth.verifyIdToken(token);
  return decoded?.auth_time;
}

export function createUserAffiliateHandler({ supabaseAdmin: admin, db, auth }) {
  const database = db;
  const service = () => createAffiliateService(database);
  return async function affiliateHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' });
    if (!admin || !database) return send(res, 503, { error: 'Affiliate service is not configured' });
    try {
      assertAffiliateOrigin(req);
      assertJsonPost(req);
      const authResult = await authenticateRequestUser(req, admin);
      if (authResult.error) return send(res, authResult.status, { error: authResult.error });
      const userId = authResult.user.id;
      assertCaller(req, userId);
      if (req.method === 'GET') return res.json(await service().dashboard(userId));
      const action = String(req.body?.action || '').trim();
      if (action === 'apply') {
        const result = await service().apply({
          userId,
          name: authResult.user.user_metadata?.name || req.body?.name,
          email: authResult.user.email,
          acceptTerms: req.body?.acceptTerms === true,
        });
        return res.json(result);
      }
      if (action === 'save-bank' || action === 'withdraw') {
        await consumeRateLimit(database, userId, action);
        const authTime = await recentAuthTime(req, auth || admin.auth);
        if (action === 'save-bank') {
          return res.json(await service().saveBankAccount({
            userId,
            bankCode: req.body?.bankCode,
            accountNumber: req.body?.accountNumber,
            accountName: req.body?.accountName,
            authTime,
          }));
        }
        return res.json(await service().requestWithdrawal({
          userId,
          amountKobo: req.body?.amountKobo,
          authTime,
        }));
      }
      return send(res, 400, { error: 'Unsupported action' });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        try { console.error('[affiliate] request failed'); } catch { /* ignore */ }
      }
      return send(res, status, { error: status >= 500 ? 'Unable to complete that request' : error.message });
    }
  };
}

export default createUserAffiliateHandler({
  supabaseAdmin,
  db: firebaseDb,
  auth: supabaseAdmin?.auth,
});
