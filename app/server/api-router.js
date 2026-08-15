// @ts-nocheck
import { createAdminHandler } from './admin-handler.js';
import creditPackagesHandler from './api/credit-packages.js';
import endSessionHandler from './api/end-session.js';
import ensureUserWalletHandler from './api/ensure-user-wallet.js';
import accountHandler from './api/account.js';
import flutterwaveWebhookHandler from './api/flutterwave-webhook.js';
import heartbeatHandler from './api/heartbeat.js';
import publicConfigHandler from './api/public-config.js';
import rateHandler from './api/rate.js';
import referralCodeHandler from './api/referral-code.js';
import referralsHandler from './api/referrals.js';
import sessionStatusHandler from './api/session-status.js';
import startSessionHandler from './api/start-session.js';
import verifyPaymentHandler from './api/verify-payment.js';
import versionHandler from './api/version.js';
import walletHandler from './api/wallet.js';
import telemetryHandler, { errorLogHandler } from './api/telemetry.js';

const routeHandlers = {
  account: accountHandler,
  'admin-audit-log': createAdminHandler('audit-log'),
  'admin-credit-packages': createAdminHandler('credit-packages'),
  'admin-me': createAdminHandler('me'),
  'admin-overview': createAdminHandler('overview'),
  'admin-referrals': createAdminHandler('referrals'),
  'admin-users': createAdminHandler('users'),
  'admin-transactions': createAdminHandler('transactions'),
  'admin-usage': createAdminHandler('usage'),
  'admin-logs': createAdminHandler('logs'),
  'credit-packages': creditPackagesHandler,
  'end-session': endSessionHandler,
  'ensure-user-wallet': ensureUserWalletHandler,
  'flutterwave-webhook': flutterwaveWebhookHandler,
  heartbeat: heartbeatHandler,
  'public-config': publicConfigHandler,
  rate: rateHandler,
  'referral-code': referralCodeHandler,
  referrals: referralsHandler,
  'session-status': sessionStatusHandler,
  'start-session': startSessionHandler,
  'verify-payment': verifyPaymentHandler,
  version: versionHandler,
  wallet: walletHandler,
  telemetry: telemetryHandler,
  'error-log': errorLogHandler,
};

function normalizeRouteSegment(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeRouteSegment).filter(Boolean).join('/');
  }

  if (typeof value === 'string') {
    return value.trim().replace(/^\/+|\/+$/g, '');
  }

  return '';
}

function getRouteName(req) {
  const queryRoute = normalizeRouteSegment(req.query?.route);
  if (queryRoute) {
    return queryRoute;
  }

  const requestUrl = req.originalUrl || req.url || '/';
  const url = new URL(requestUrl, 'http://localhost');
  return url.pathname.replace(/^\/api\/?/, '').replace(/^\/+|\/+$/g, '');
}

async function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8'));
    } catch {
      return {};
    }
  }

  if (req.readable && typeof req.on === 'function' && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBuffer = Buffer.concat(chunks);
      if (!req.rawBody) {
        req.rawBody = rawBuffer;
      }
      const rawText = rawBuffer.toString('utf8');
      if (rawText.trim()) {
        return JSON.parse(rawText);
      }
    } catch {
      return {};
    }
  }

  return req.body || {};
}

export async function handleApiRoute(req, res) {
  const routeName = getRouteName(req);
  const routeHandler = routeHandlers[routeName];

  if (!routeHandler) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    return res.status(404).json({ error: 'API route not found' });
  }

  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    req.body = await parseRequestBody(req);
  } else if (!req.body) {
    req.body = {};
  }

  return routeHandler(req, res);
}

export default handleApiRoute;
