// @ts-nocheck
import { handleApiRoute } from '../app/server/api-router.js';

export default async function safeHandleApiRoute(req, res) {
  try {
    return await handleApiRoute(req, res);
  } catch (err) {
    console.error('CRITICAL VERCEL CRASH:', err);
    res.setHeader?.('Content-Type', 'application/json');
    res.status?.(500).json({ error: 'Vercel Crash', details: err?.message || String(err), stack: err?.stack });
  }
}
