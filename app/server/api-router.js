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

  return routeHandler(req, res);
}

export default handleApiRoute;
