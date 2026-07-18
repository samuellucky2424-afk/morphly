// @ts-nocheck
import { authenticateRequestUser, getAdminMembership, requireAdminContext } from '../../shared/admin-auth.js';
import { readAdminAuditLog } from '../../shared/admin-audit.js';
import {
  addCreditsToUser,
  deleteUserAccount,
  getAdminOverview,
  listAdminUsers,
  listAdminTransactions,
  listSystemLogs,
  setUserStatus,
  listCreditPackages,
  updateCreditPackages,
} from '../../shared/admin-service.js';
import { createCreditPackage } from '../../shared/credit-packages.js';
import { logErrorEvent, logRequestEvent } from '../../shared/backend-logger.js';
import { supabaseAdmin, supabaseAdminConfigError } from './supabase-admin.js';

const ADMIN_ROUTE_CONFIG = {
  me: {
    path: '/api/admin-me',
    methods: ['GET'],
    event: 'admin-me',
    handler: handleAdminMe,
  },
  overview: {
    path: '/api/admin-overview',
    methods: ['GET'],
    event: 'admin-overview',
    handler: handleAdminOverview,
  },
  users: {
    path: '/api/admin-users',
    methods: ['GET', 'POST', 'DELETE'],
    event: 'admin-users',
    handler: handleAdminUsers,
  },
  transactions: { path: '/api/admin-transactions', methods: ['GET'], event: 'admin-transactions', handler: handleAdminTransactions },
  logs: { path: '/api/admin-logs', methods: ['GET'], event: 'admin-logs', handler: handleAdminLogs },
  'credit-packages': {
    path: '/api/admin-credit-packages',
    methods: ['GET', 'POST', 'PUT'],
    event: 'admin-credit-packages',
    handler: handleAdminCreditPackages,
  },
  'audit-log': {
    path: '/api/admin-audit-log',
    methods: ['GET'],
    event: 'admin-audit-log',
    handler: handleAdminAuditLog,
  },
};

function normalizeRouteName(value) {
  if (Array.isArray(value)) {
    return normalizeRouteName(value[0]);
  }

  return typeof value === 'string' ? value.trim() : '';
}

function setResponseHeaders(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function createAdminHandler(routeName) {
  return async function adminHandler(req, res) {
    return handleAdminRoute(routeName, req, res);
  };
}

export async function handleAdminRoute(routeName, req, res) {
  const normalizedRoute = normalizeRouteName(routeName);
  const routeConfig = ADMIN_ROUTE_CONFIG[normalizedRoute];

  if (!routeConfig) {
    setResponseHeaders(res, ['GET']);
    return res.status(404).json({ error: 'Admin route not found' });
  }

  setResponseHeaders(res, routeConfig.methods);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!routeConfig.methods.includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });
  }

  return routeConfig.handler(req, res, routeConfig);
}

async function handleAdminMe(req, res, routeConfig) {
  await logRequestEvent(`${routeConfig.event}.request`, {
    method: req.method,
    path: routeConfig.path,
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
    await logErrorEvent(`${routeConfig.event}.exception`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleAdminOverview(req, res, routeConfig) {
  await logRequestEvent(`${routeConfig.event}.request`, {
    method: req.method,
    path: routeConfig.path,
  });

  try {
    const adminContext = await requireAdminContext(req, res, supabaseAdmin);
    if (!adminContext) {
      return;
    }

    const overview = await getAdminOverview(supabaseAdmin);
    return res.json(overview);
  } catch (error) {
    await logErrorEvent(`${routeConfig.event}.exception`, error);
    return res.status(500).json({ error: 'Failed to load admin overview' });
  }
}

async function handleAdminUsers(req, res, routeConfig) {
  await logRequestEvent(`${routeConfig.event}.request`, {
    method: req.method,
    path: routeConfig.path,
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
      if (req.body?.action === 'status') {
        const result = await setUserStatus(supabaseAdmin, { ...req.body, adminUserId: adminContext.user.id });
        return res.json(result);
      }
      const result = await addCreditsToUser(supabaseAdmin, {
        userId: req.body?.userId,
        creditsToAdd: req.body?.creditsToAdd ?? req.body?.amount,
        reason: req.body?.reason,
        idempotencyKey: req.body?.idempotencyKey,
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
    await logErrorEvent(`${routeConfig.event}.exception`, error, {
      method: req.method,
    });
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
}

async function handleAdminCreditPackages(req, res, routeConfig) {
  await logRequestEvent(`${routeConfig.event}.request`, {
    method: req.method,
    path: routeConfig.path,
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

    if (req.method === 'POST') {
      const packageRecord = await createCreditPackage(supabaseAdmin, req.body);
      await supabaseAdmin.from('admin_audit_logs').insert({ admin_user_id: adminContext.user.id, action: 'package.created', target_type: 'credit_package', target_id: packageRecord.id, after_data: packageRecord });
      return res.status(201).json(packageRecord);
    }

    const packages = await updateCreditPackages(supabaseAdmin, req.body?.packages);

    await supabaseAdmin.from('admin_audit_logs').insert({ admin_user_id: adminContext.user.id, action: 'packages.updated', target_type: 'credit_package', after_data: { count: packages.length } });

    await logRequestEvent('admin-credit-packages.updated', {
      adminUserId: adminContext.user.id,
      count: packages.length,
    });

    return res.json({ packages });
  } catch (error) {
    await logErrorEvent(`${routeConfig.event}.exception`, error, {
      method: req.method,
    });
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
}

async function handleAdminAuditLog(req, res, routeConfig) {
  await logRequestEvent(`${routeConfig.event}.request`, {
    method: req.method,
    path: routeConfig.path,
  });

  try {
    const adminContext = await requireAdminContext(req, res, supabaseAdmin);
    if (!adminContext) {
      return;
    }

    const entries = await readAdminAuditLog({ limit: req.query?.limit || 50 }, supabaseAdmin);
    return res.json({ entries });
  } catch (error) {
    await logErrorEvent(`${routeConfig.event}.exception`, error);
    return res.status(500).json({ error: 'Failed to load admin audit log' });
  }
}

async function handleAdminTransactions(req, res) {
  try { const admin = await requireAdminContext(req, res, supabaseAdmin); if (!admin) return; return res.json({ transactions: await listAdminTransactions(supabaseAdmin) }); }
  catch (error) { await logErrorEvent('admin-transactions.exception', error); return res.status(500).json({ error: 'Failed to load transactions' }); }
}

async function handleAdminLogs(req, res) {
  try { const admin = await requireAdminContext(req, res, supabaseAdmin); if (!admin) return; return res.json({ logs: await listSystemLogs(supabaseAdmin) }); }
  catch (error) { await logErrorEvent('admin-logs.exception', error); return res.status(500).json({ error: 'Failed to load logs' }); }
}
