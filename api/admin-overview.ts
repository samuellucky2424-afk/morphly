// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { requireAdminContext } from '../shared/admin-auth.js';
import { getAdminOverview } from '../shared/admin-service.js';
import { logErrorEvent, logRequestEvent } from '../shared/backend-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  await logRequestEvent('admin-overview.request', {
    method: req.method,
    path: '/api/admin-overview',
  });

  try {
    const adminContext = await requireAdminContext(req, res, supabaseAdmin);
    if (!adminContext) {
      return;
    }

    const overview = await getAdminOverview(supabaseAdmin);
    return res.json(overview);
  } catch (error) {
    await logErrorEvent('admin-overview.exception', error);
    return res.status(500).json({ error: 'Failed to load admin overview' });
  }
}