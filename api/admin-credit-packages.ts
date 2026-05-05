// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { listCreditPackages, updateCreditPackages } from '../shared/admin-service.js';
import { requireAdminContext } from '../shared/admin-auth.js';
import { logErrorEvent, logRequestEvent } from '../shared/backend-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'PUT'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  await logRequestEvent('admin-credit-packages.request', {
    method: req.method,
    path: '/api/admin-credit-packages',
  });

  try {
    const adminContext = await requireAdminContext(req, res, supabaseAdmin);
    if (!adminContext) {
      return;
    }

    if (req.method === 'GET') {
      const packages = await listCreditPackages(supabaseAdmin, { includeInactive: true });
      return res.json({ packages });
    }

    const packages = await updateCreditPackages(supabaseAdmin, req.body?.packages);

    await logRequestEvent('admin-credit-packages.updated', {
      adminUserId: adminContext.user.id,
      count: packages.length,
    });

    return res.json({ packages });
  } catch (error) {
    await logErrorEvent('admin-credit-packages.exception', error, {
      method: req.method,
    });
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
}