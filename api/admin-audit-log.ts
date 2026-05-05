// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { requireAdminContext } from '../shared/admin-auth.js';
import { readAdminAuditLog } from '../shared/admin-audit.js';
import { logErrorEvent, logRequestEvent } from '../shared/backend-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  await logRequestEvent('admin-audit-log.request', {
    method: req.method,
    path: '/api/admin-audit-log',
  });

  try {
    const adminContext = await requireAdminContext(req, res, supabaseAdmin);
    if (!adminContext) {
      return;
    }

    const entries = await readAdminAuditLog({ limit: req.query?.limit || 50 });
    return res.json({ entries });
  } catch (error) {
    await logErrorEvent('admin-audit-log.exception', error);
    return res.status(500).json({ error: 'Failed to load admin audit log' });
  }
}