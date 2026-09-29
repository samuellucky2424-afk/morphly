import { createServer } from 'node:http';
import { attachTranslationGateway } from './translation-gateway.js';

// Export the unbound HTTP server to Vercel; the platform owns its listening port.
export function createTranslationHttpServer(options = {}) {
  const configured = Boolean(options.supabase && options.apiKey?.trim());
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url?.split('?')[0] !== '/api/translation/live') {
      res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    // Reports configuration presence only; does not spend credits or call Gemini.
    res.writeHead(configured ? 200 : 503).end(JSON.stringify({
      configured,
      transport: 'websocket',
      ...(configured ? {} : { error: 'Translation server credentials are not configured.' }),
    }));
  });
  attachTranslationGateway(server, options);
  return server;
}
