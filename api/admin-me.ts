// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { authenticateRequestUser, getAdminMembership } from '../shared/admin-auth.js';
import { logErrorEvent, logRequestEvent } from '../shared/backend-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  await logRequestEvent('admin-me.request', {
    method: req.method,
    path: '/api/admin-me',
  });

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) {
      return res.status(authResult.status).json({ error: authResult.error });
    }

    const membership = await getAdminMembership(supabaseAdmin, authResult.user.id);

    return res.json({
      isAdmin: Boolean(membership),
      role: membership?.role ?? null,
      email: authResult.user.email || null,
      userId: authResult.user.id,
    });
  } catch (error) {
    await logErrorEvent('admin-me.exception', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}