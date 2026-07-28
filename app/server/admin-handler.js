// @ts-nocheck
import { authenticateRequestUser, getAdminMembership, requireAdminContext } from '../../shared/admin-auth.js';
import { readAdminAuditLog } from '../../shared/admin-audit.js';
import {
  addCreditsToUser,
  deleteUserAccount,
  getAdminOverview,
  listAdminUsers,
  listAdminTransactions,
  listAdminUsage,
  listAdminReferrals,
  disqualifyAdminReferral,
  listSystemLogs,
  setUserStatus,
  listCreditPackages,
  updateCreditPackages,
} from '../../shared/admin-service.js';
import { createCreditPackage } from '../../shared/credit-packages.js';
import { logErrorEvent, logRequestEvent } from '../../shared/backend-logger.js';
import { supabaseAdmin, supabaseAdminConfigError } from './supabase-admin.js';
import {
  applyVerifiedFlutterwavePayment,
  extractFlutterwavePaymentContext,
  validateFlutterwaveTransaction,
  verifyFlutterwaveTransaction,
} from './flutterwave-payment.js';

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
  transactions: { path: '/api/admin-transactions', methods: ['GET', 'POST'], event: 'admin-transactions', handler: handleAdminTransactions },
  usage: { path: '/api/admin-usage', methods: ['GET'], event: 'admin-usage', handler: handleAdminUsage },
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
  referrals: {
    path: '/api/admin-referrals',
    methods: ['GET', 'POST'],
    event: 'admin-referrals',
    handler: handleAdminReferrals,
  },
};

function normalizeRouteName(value) {
  if (Array.isArray(value)) {
    return normalizeRouteName(value[0]);
  }

  return typeof value === 'string' ? value.trim() : '';
}

function getReportOptions(req) {
  return {
    days: req.query?.days,
    platform: req.query?.platform,
    source: req.query?.source,
    status: req.query?.status,
  };
}

async function handleAdminReferrals(req, res, routeConfig) {
  await logRequestEvent(`${routeConfig.event}.request`, {
    method: req.method,
    path: routeConfig.path,
  });

  try {
    const adminContext = await requireAdminContext(req, res, supabaseAdmin);
    if (!adminContext) return;

    if (req.method === 'GET') {
      return res.json(await listAdminReferrals(supabaseAdmin, getReportOptions(req)));
    }

    const result = await disqualifyAdminReferral(supabaseAdmin, {
      referralId: req.body?.referralId,
      reason: req.body?.reason,
      adminUserId: adminContext.user.id,
    });
    return res.json(result);
  } catch (error) {
    await logErrorEvent(`${routeConfig.event}.exception`, error);
    return res.status(500).json({ error: 'Failed to load referral administration data' });
  }
}

function setResponseHeaders(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');
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

    const overview = await getAdminOverview(supabaseAdmin, getReportOptions(req));
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
      const users = await listAdminUsers(supabaseAdmin, getReportOptions(req));
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
  try {
    const admin = await requireAdminContext(req, res, supabaseAdmin); if (!admin) return;
    if (req.method === 'GET') {
      return res.json({
        transactions: await listAdminTransactions(supabaseAdmin, getReportOptions(req)),
        asOf: new Date().toISOString(),
      });
    }

    const transactionId = String(req.body?.transactionId || '').trim();
    const userId = String(req.body?.userId || '').trim();
    const packageId = String(req.body?.packageId || '').trim();
    const expectedReference = String(req.body?.reference || '').trim() || null;
    if (!transactionId || !userId || !packageId) return res.status(400).json({ error: 'Transaction ID, user and package are required' });
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secretKey) return res.status(500).json({ error: 'Flutterwave verification is not configured' });

    const verification = await verifyFlutterwaveTransaction(transactionId, secretKey);
    if (!verification.isVerified) return res.status(400).json({ error: verification.data?.message || 'Flutterwave could not verify this payment' });
    const context = extractFlutterwavePaymentContext(verification.transaction, { reference: expectedReference, userId, packageId });
    const gatewayPackageId = verification.transaction?.meta?.packageId || verification.transaction?.meta?.package_id;
    if (gatewayPackageId && gatewayPackageId !== packageId) return res.status(400).json({ error: 'Payment package mismatch' });
    const validation = validateFlutterwaveTransaction(verification.transaction, context.reference);
    if (!validation.ok) return res.status(400).json({ error: validation.message });

    const result = await applyVerifiedFlutterwavePayment({
      reference: validation.reference, userId, packageId, transactionId,
      amountPaidNGN: validation.amountPaidNGN,
      gatewayFeeNGN: Number(verification.transaction?.app_fee || 0),
    });
    await supabaseAdmin.from('admin_audit_logs').insert({
      admin_user_id: admin.user.id, action: 'payment.reconciled', target_type: 'transaction',
      target_id: String(transactionId), reason: 'Admin verified against Flutterwave',
      after_data: { userId, packageId, reference: validation.reference, amountPaidNGN: validation.amountPaidNGN, ...result },
    });
    return res.json(result);
  }
  catch (error) { await logErrorEvent('admin-transactions.exception', error); return res.status(500).json({ error: error instanceof Error ? error.message : 'Transaction operation failed' }); }
}

async function handleAdminUsage(req, res, routeConfig) {
  await logRequestEvent(`${routeConfig.event}.request`, {
    method: req.method,
    path: routeConfig.path,
  });

  try {
    const admin = await requireAdminContext(req, res, supabaseAdmin);
    if (!admin) return;
    return res.json(await listAdminUsage(supabaseAdmin, getReportOptions(req)));
  } catch (error) {
    await logErrorEvent(`${routeConfig.event}.exception`, error);
    return res.status(500).json({ error: 'Failed to load AI provider usage' });
  }
}

async function handleAdminLogs(req, res) {
  try {
    const admin = await requireAdminContext(req, res, supabaseAdmin); if (!admin) return;
    return res.json({
      logs: await listSystemLogs(supabaseAdmin, getReportOptions(req)),
      asOf: new Date().toISOString(),
    });
  }
  catch (error) { await logErrorEvent('admin-logs.exception', error); return res.status(500).json({ error: 'Failed to load logs' }); }
}
