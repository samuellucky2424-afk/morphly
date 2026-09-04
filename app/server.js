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
import { createMeanVcRuntimeController } from './server/meanvc-runtime.js';

const app = express();
const PORT = process.env.PORT || 3000;
const xmaxConfigError = process.env.XMAX_API_KEY?.trim()
  ? null
  : 'Missing XMAX_API_KEY';
const decartConfigError = process.env.DECART_API_KEY?.trim()
  ? null
  : 'Missing DECART_API_KEY';
const meanVcRuntime = createMeanVcRuntimeController({
  repositoryRoot: path.resolve(__dirname, '../third_party/MeanVC2'),
  dataRoot: path.resolve(__dirname, '.meanvc'),
});

function requireLocalMeanVcRequest(req, res, next) {
  const remoteAddress = req.socket.remoteAddress ?? '';
  const isLoopback = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  const origin = req.get('origin');
  let isTrustedOrigin = !origin || origin === 'null';

  if (origin && origin !== 'null') {
    try {
      const hostname = new URL(origin).hostname;
      isTrustedOrigin = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '[::1]';
    } catch {
      isTrustedOrigin = false;
    }
  }

  if (!isLoopback || !isTrustedOrigin) {
    res.status(403).json({ error: 'MorphlyVC controls are available only from this computer.' });
    return;
  }

  next();
}

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

// Local MorphlyVC controls are deliberately limited to loopback requests because
// they inspect local files and can start a Python audio process.
app.use('/api/local/meanvc', requireLocalMeanVcRequest);
app.get('/api/local/meanvc/status', (_req, res) => {
  res.json(meanVcRuntime.getStatus());
});
app.post(
  '/api/local/meanvc/reference',
  express.raw({ type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'], limit: '25mb' }),
  (req, res) => {
    try {
      const encodedName = String(req.get('x-meanvc-filename') || 'reference.wav');
      const originalName = decodeURIComponent(encodedName);
      res.json(meanVcRuntime.saveReference(req.body, originalName));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to save the reference audio.' });
    }
  },
);
app.post('/api/local/meanvc/prepare', (req, res) => {
  try {
    res.json(meanVcRuntime.prepare(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to prepare the MorphlyVC voice.' });
  }
});
app.post('/api/local/meanvc/start', (req, res) => {
  try {
    res.json(meanVcRuntime.start(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to start MorphlyVC.' });
  }
});
app.post('/api/local/meanvc/pitch', (req, res) => {
  try {
    res.json(meanVcRuntime.setPitch(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to update MorphlyVC pitch.' });
  }
});
app.post('/api/local/meanvc/stop', (_req, res) => {
  res.json(meanVcRuntime.stop());
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
  if (supabaseAdminConfigError) {
    console.warn(`[config] ${supabaseAdminConfigError}`);
  }
  if (xmaxConfigError) {
    console.warn(`[config] ${xmaxConfigError}`);
  }
  if (decartConfigError) {
    console.warn(`[config] ${decartConfigError}`);
  }
});

process.once('exit', () => {
  meanVcRuntime.shutdown();
});
