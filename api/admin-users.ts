// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { addCreditsToUser, deleteUserAccount, listAdminUsers } from '../shared/admin-service.js';
import { requireAdminContext } from '../shared/admin-auth.js';
import { logErrorEvent, logRequestEvent } from '../shared/backend-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  await logRequestEvent('admin-users.request', {
    method: req.method,
    path: '/api/admin-users',
  });

  try {
    const adminContext = await requireAdminContext(req, res, supabaseAdmin);
    if (!adminContext) {
      return;
    }

    if (req.method === 'GET') {
      const users = await listAdminUsers(supabaseAdmin);
      return res.json({ users });
    }

    if (req.method === 'POST') {
      const result = await addCreditsToUser(supabaseAdmin, {
        userId: req.body?.userId,
        creditsToAdd: req.body?.creditsToAdd,
        adminUserId: adminContext.user.id,
      });

      await logRequestEvent('admin-users.credits_added', {
        adminUserId: adminContext.user.id,
        userId: result.userId,
        creditsAdded: result.creditsAdded,
        newCredits: result.newCredits,
      });

      return res.json(result);
    }

    if (req.body?.userId === adminContext.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own admin account from this dashboard' });
    }

    const result = await deleteUserAccount(supabaseAdmin, {
      userId: req.body?.userId,
    });

    await logRequestEvent('admin-users.deleted', {
      adminUserId: adminContext.user.id,
      userId: result.userId,
    });

    return res.json(result);
  } catch (error) {
    await logErrorEvent('admin-users.exception', error, {
      method: req.method,
    });
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
}