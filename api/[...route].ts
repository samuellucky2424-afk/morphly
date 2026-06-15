// @ts-nocheck
import { createAdminHandler } from '../app/server/admin-handler.js';
import creditPackagesHandler from '../app/api/credit-packages.ts';
import endSessionHandler from '../app/api/end-session.ts';
import ensureUserWalletHandler from '../app/api/ensure-user-wallet.ts';
import flutterwaveWebhookHandler from '../app/api/flutterwave-webhook.ts';
import heartbeatHandler from '../app/api/heartbeat.ts';
import publicConfigHandler from '../app/api/public-config.ts';
import rateHandler from '../app/api/rate.ts';
import sessionStatusHandler from '../app/api/session-status.ts';
import startSessionHandler from '../app/api/start-session.ts';
import verifyPaymentHandler from '../app/api/verify-payment.ts';
import versionHandler from '../app/api/version.ts';
import walletHandler from '../app/api/wallet.ts';

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

  const url = new URL(req.url || '/', 'http://localhost');
  return url.pathname.replace(/^\/api\/?/, '').replace(/^\/+|\/+$/g, '');
}

export default async function handler(req, res) {
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
