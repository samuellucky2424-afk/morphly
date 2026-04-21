// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

const CREDITS_PER_SECOND = 2;

// Just closes orphaned sessions without any billing.
// Credits were already billed in real-time via /api/heartbeat while the
// session was active. Any time after the last heartbeat is free.
async function closeOrphanedSession(sessionId) {
  try {
    await supabaseAdmin
      .from('sessions')
      .update({ end_time: new Date(), status: 'ended' })
      .eq('id', sessionId)
      .eq('status', 'active');
  } catch (err) {
    console.error('Failed to close orphaned session:', err);
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
      .from('sessions').select('*').eq('user_id', userId).eq('status', 'active');

    if (existingActiveSessions && existingActiveSessions.length > 0) {
      for (const session of existingActiveSessions) {
        await closeOrphanedSession(session.id);
      }
    }

    const { data: freshWallet } = await supabaseAdmin
      .from('wallets').select('credits').eq('user_id', userId).single();

    const userCredits = freshWallet?.credits || 0;
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
