// @ts-nocheck
import { createAdminHandler } from './admin-handler.js';
import creditPackagesHandler from './api/credit-packages.ts';
import endSessionHandler from './api/end-session.ts';
import ensureUserWalletHandler from './api/ensure-user-wallet.ts';
import flutterwaveWebhookHandler from './api/flutterwave-webhook.ts';
import heartbeatHandler from './api/heartbeat.ts';
import publicConfigHandler from './api/public-config.ts';
import rateHandler from './api/rate.ts';
import sessionStatusHandler from './api/session-status.ts';
import startSessionHandler from './api/start-session.ts';
import verifyPaymentHandler from './api/verify-payment.ts';
import versionHandler from './api/version.ts';
import walletHandler from './api/wallet.ts';

const routeHandlers = {
  'admin-audit-log': createAdminHandler('audit-log'),
  'admin-credit-packages': createAdminHandler('credit-packages'),
  'admin-me': createAdminHandler('me'),
  'admin-overview': createAdminHandler('overview'),
  'admin-users': createAdminHandler('users'),
  'credit-packages': creditPackagesHandler,
  'end-session': endSessionHandler,
  'ensure-user-wallet': ensureUserWalletHandler,
  'flutterwave-webhook': flutterwaveWebhookHandler,
  heartbeat: heartbeatHandler,
  'public-config': publicConfigHandler,
  rate: rateHandler,
  'session-status': sessionStatusHandler,
  'start-session': startSessionHandler,
  'verify-payment': verifyPaymentHandler,
  version: versionHandler,
  wallet: walletHandler,
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
