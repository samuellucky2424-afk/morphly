import './shared/load-server-environment.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { supabaseAdminConfigError } from './server/supabase-admin.js';
import { logRequestEvent } from '../shared/backend-logger.js';
import { handleApiRoute } from './server/api-router.js';

const app = express();
const PORT = process.env.PORT || 3000;
const decartConfigError = process.env.DECART_API_KEY?.trim()
  ? null
  : 'Missing DECART_API_KEY';

// Middleware
app.use(cors());
app.use(express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));
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
app.use('/api', handleApiRoute);

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
