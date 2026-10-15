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
const viduConfigError = process.env.VIDU_API_KEY?.trim()
  ? null
  : 'Missing VIDU_API_KEY';
const elevenLabsConfigError = process.env.ELEVENLABS_API_KEY?.trim()
  ? null
  : 'Missing ELEVENLABS_API_KEY (voice changer)';

// Middleware
app.use(cors());
app.use(express.json({
  // Voice uploads are sent as base64 JSON (up to 3 MB of audio).
  limit: '5mb',
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

// Hosted application API routes.
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
  for (const configError of [supabaseAdminConfigError, decartConfigError, viduConfigError, elevenLabsConfigError]) {
    if (configError) console.warn(`[config] ${configError}`);
  }
});
