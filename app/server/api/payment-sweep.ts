// @ts-nocheck
import { firebaseDb } from '../firebase-admin.js';
import { cronAuthorized } from '../customer-engagement.js';
import { sweepPendingCheckouts } from '../payment-checkouts.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!cronAuthorized(req.headers?.authorization, process.env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  if (!firebaseDb) return res.status(503).json({ error: 'Checkout storage is not configured' });
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secretKey) return res.status(503).json({ error: 'FLUTTERWAVE_SECRET_KEY is not configured' });
  try {
    return res.json(await sweepPendingCheckouts(firebaseDb, { secretKey }));
  } catch {
    return res.status(500).json({ error: 'Payment sweep failed' });
  }
}
