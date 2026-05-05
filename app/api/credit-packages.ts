// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../server/supabase-admin.js';
import { listCreditPackages } from '../../shared/credit-packages.js';
import { logErrorEvent, logRequestEvent } from '../../shared/backend-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  await logRequestEvent('credit-packages.request', {
    method: req.method,
    path: '/api/credit-packages',
  });

  try {
    const packages = await listCreditPackages(supabaseAdmin);
    return res.json({ packages });
  } catch (error) {
    await logErrorEvent('credit-packages.exception', error);
    return res.status(500).json({ error: 'Failed to load credit packages' });
  }
}