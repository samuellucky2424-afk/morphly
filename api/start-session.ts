// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;

// When the user logs in or starts a new session, any previously orphaned
// active session is billed for exactly how long it ran (start_time → now),
// capped at max_seconds. This is fair: they used the service, they pay for it.
async function billAndCloseOrphanedSession(session, userId, walletCredits) {
  try {
    const elapsedSeconds = Math.floor(
      (Date.now() - new Date(session.start_time).getTime()) / 1000,
    );
    const storedMax = typeof session.max_seconds === 'number' && session.max_seconds > 0
      ? session.max_seconds
      : MAX_BILLABLE_SECONDS;
    const billableSeconds = Math.min(elapsedSeconds, storedMax);
    const creditsToDeduct = Math.min(walletCredits, billableSeconds * CREDITS_PER_SECOND);
    const newCredits = walletCredits - creditsToDeduct;

    await Promise.all([
      supabaseAdmin
        .from('sessions')
        .update({ end_time: new Date(), status: 'ended', seconds_used: billableSeconds, credits_used: creditsToDeduct })
        .eq('id', session.id).eq('status', 'active'),
      creditsToDeduct > 0
        ? supabaseAdmin.from('wallets').update({ credits: newCredits }).eq('user_id', userId)
        : Promise.resolve(),
    ]);

    return newCredits;
  } catch (err) {
    console.error('Failed to close orphaned session:', err);
    return walletCredits;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ allowed: false, error: 'User ID is required' });

    const { data: existingActiveSessions } = await supabaseAdmin
      .from('sessions').select('id, start_time, max_seconds').eq('user_id', userId).eq('status', 'active');

    // Bill and close any orphaned sessions first, then re-read wallet
    let runningCredits = null;
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      const { data: walletNow } = await supabaseAdmin
        .from('wallets').select('credits').eq('user_id', userId).single();
      runningCredits = walletNow?.credits ?? 0;
      for (const session of existingActiveSessions) {
        runningCredits = await billAndCloseOrphanedSession(session, userId, runningCredits);
      }
    }

    const { data: freshWallet } = await supabaseAdmin
      .from('wallets').select('credits').eq('user_id', userId).single();

    const userCredits = freshWallet?.credits ?? runningCredits ?? 0;
    if (userCredits <= 0) {
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    // Declare maxSeconds BEFORE the insert so it is stored correctly in the DB.
    // (Previously it was declared after the insert, causing max_seconds = NULL
    //  which made closeActiveSession fall back to wiping the entire balance.)
    const maxSeconds = Math.floor(userCredits / CREDITS_PER_SECOND);

    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,
        status: 'active',
        start_time: new Date(),
        credits_used: 0,
        seconds_used: 0,
        max_seconds: maxSeconds
      }).select('id').single();

    if (sessionError) return res.status(500).json({ allowed: false, error: 'Failed to create session' });

    res.json({ allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds, token: process.env.DECART_API_KEY });
  } catch (error) {
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}
