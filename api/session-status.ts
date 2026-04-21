// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || req.query.id;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    const [{ data: walletData }, { data: activeSession }] = await Promise.all([
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).single(),
      supabaseAdmin
        .from('sessions')
        .select('id, start_time')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
    ]);

    const walletCredits = walletData?.credits ?? 0;

    if (!activeSession) {
      return res.json({ credits: walletCredits, remainingCredits: walletCredits, shouldStop: walletCredits <= 0 });
    }

    // Compute live balance: wallet credits minus every second elapsed since start.
    // This is purely a read — no DB writes. The actual deduction happens in
    // end-session so the wallet value stays stable during streaming.
    const elapsedSeconds = Math.floor(
      (Date.now() - new Date(activeSession.start_time).getTime()) / 1000,
    );
    const billableElapsed = Math.min(elapsedSeconds, MAX_BILLABLE_SECONDS);
    const liveDeducted = Math.min(walletCredits, billableElapsed * CREDITS_PER_SECOND);
    const remainingCredits = Math.max(0, walletCredits - liveDeducted);
    const shouldStop = remainingCredits <= 0;

    return res.json({
      credits: remainingCredits,
      remainingCredits,
      elapsedSeconds: billableElapsed,
      shouldStop,
      forceEnd: shouldStop,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}
