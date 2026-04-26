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
import verifyPaymentRouter from './api/verify-payment.ts';
import startSessionRouter from './api/start-session.ts';
import sessionStatusRouter from './api/session-status.ts';
import endSessionRouter from './api/end-session.ts';
import versionRouter from './api/version.ts';
import { supabaseAdminConfigError } from './api/supabase.ts';

const app = express();
const PORT = process.env.PORT || 3000;
const decartConfigError = process.env.DECART_API_KEY?.trim()
  ? null
  : 'Missing DECART_API_KEY';

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/rate', rateRouter);
app.use('/api/wallet', walletRouter);
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
