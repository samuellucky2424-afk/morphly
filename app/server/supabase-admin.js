// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { logDbQueryEvent, logErrorEvent } from '../../shared/backend-logger.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const nativeFetch = globalThis.fetch?.bind(globalThis);

function shouldLogSupabaseUrl(url) {
  return typeof url === 'string' && (url.includes('/rest/v1/') || url.includes('/rpc/'));
}

function normalizeUrl(input) {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }

  return String(input);
}

async function loggedSupabaseFetch(input, init) {
  if (!nativeFetch) {
    throw new Error('Global fetch is not available');
  }

  const startedAt = Date.now();
  const url = normalizeUrl(input);
  const method = String(init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();

  try {
    const response = await nativeFetch(input, init);

    if (shouldLogSupabaseUrl(url)) {
      void logDbQueryEvent('supabase.query', {
        method,
        url,
        statusCode: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });

      if (!response.ok) {
        void logErrorEvent('supabase.query_failed', new Error(`Supabase query returned ${response.status}`), {
          method,
          url,
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    return response;
  } catch (error) {
    if (shouldLogSupabaseUrl(url)) {
      void logErrorEvent('supabase.query_exception', error, {
        method,
        url,
        durationMs: Date.now() - startedAt,
      });
    }

    throw error;
  }
}

export const supabaseAdminConfigError = !supabaseUrl
  ? 'Missing SUPABASE_URL or VITE_SUPABASE_URL'
  : !supabaseServiceKey
    ? 'Missing SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY'
    : null;

export const supabaseAdmin = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: loggedSupabaseFetch },
    })
  : null;