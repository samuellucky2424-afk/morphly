import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Share the same handlers between local dev and the Vercel app-root deployment.
import rateRouter from './api/rate.ts';
import walletRouter from './api/wallet.ts';
import creditPackagesRouter from './api/credit-packages.ts';
import verifyPaymentRouter from './api/verify-payment.ts';
import startSessionRouter from './api/start-session.ts';
import sessionStatusRouter from './api/session-status.ts';
import endSessionRouter from './api/end-session.ts';
import versionRouter from './api/version.ts';
import { createAdminHandler } from './server/admin-handler.js';
import { supabaseAdminConfigError } from './server/supabase-admin.js';
import { logRequestEvent } from '../shared/backend-logger.js';

const adminMeRouter = createAdminHandler('me');
const adminOverviewRouter = createAdminHandler('overview');
const adminUsersRouter = createAdminHandler('users');
const adminCreditPackagesRouter = createAdminHandler('credit-packages');
const adminAuditLogRouter = createAdminHandler('audit-log');

const app = express();
const PORT = process.env.PORT || 3000;
const decartConfigError = process.env.DECART_API_KEY?.trim()
  ? null
  : 'Missing DECART_API_KEY';

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();

  void logRequestEvent('http.request', {
    method: req.method,
    path: req.originalUrl,
    query: req.query,
    ip: req.ip,
  });

  res.on('finish', () => {
    void logRequestEvent('http.response', {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});

// API Routes
app.use('/api/rate', rateRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/credit-packages', creditPackagesRouter);
app.use('/api/admin-me', adminMeRouter);
app.use('/api/admin-overview', adminOverviewRouter);
app.use('/api/admin-users', adminUsersRouter);
app.use('/api/admin-credit-packages', adminCreditPackagesRouter);
app.use('/api/admin-audit-log', adminAuditLogRouter);
app.use('/api/verify-payment', verifyPaymentRouter);
app.use('/api/start-session', startSessionRouter);
app.use('/api/session-status', sessionStatusRouter);
app.use('/api/end-session', endSessionRouter);
app.use('/api/version', versionRouter);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (supabaseAdminConfigError) {
    console.warn(`[config] ${supabaseAdminConfigError}`);
  }
  if (decartConfigError) {
    console.warn(`[config] ${decartConfigError}`);
  }
});
