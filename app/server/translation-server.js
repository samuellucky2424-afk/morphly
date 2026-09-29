import '../shared/load-server-environment.js';
import { createServer } from 'node:http';
import { supabaseAdmin, supabaseAdminConfigError } from './supabase-admin.js';
import { attachTranslationGateway } from './translation-gateway.js';

if (!supabaseAdmin || !process.env.GEMINI_API_KEY?.trim()) {
  throw new Error(supabaseAdminConfigError || 'GEMINI_API_KEY is required on the translation server.');
}

// Deploy this entrypoint on a persistent Node host; no local voice engine runs here.
const server = createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url === '/health' ? { status: 'ok' } : { error: 'Not found' }));
});
const gateway = attachTranslationGateway(server, { supabase: supabaseAdmin });
server.listen(Number(process.env.PORT || 3001), '0.0.0.0');
function shutdown() {
  // Closing sockets triggers final credit settlement before the process exits.
  for (const client of gateway.clients) client.close(1001, 'Server restarting');
  server.close();
  const deadline = setTimeout(() => process.exit(0), 10000);
  deadline.unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
