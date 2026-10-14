import { waitUntil } from '@vercel/functions';
import { supabaseAdmin } from './supabase-admin.js';
import { createViduDemoProxyServer } from './vidu-demo-proxy.js';

export default createViduDemoProxyServer({ supabase: supabaseAdmin, waitUntil });
