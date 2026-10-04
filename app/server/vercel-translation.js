import { supabaseAdmin } from './supabase-admin.js';
import { waitUntil } from '@vercel/functions';
import { createTranslationHttpServer } from './translation-http-server.js';

export default createTranslationHttpServer({
  supabase: supabaseAdmin,
  apiKey: process.env.GEMINI_API_KEY?.trim(),
  // Leave time for unused credit reservations to settle before Vercel's 300s limit.
  maxSessionMs: 270000,
  waitUntil,
});
