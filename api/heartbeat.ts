// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

// How many seconds each heartbeat tick represents.
// The client calls this endpoint on this same interval.
const HEARTBEAT_SECONDS = 30;
const CREDITS_PER_SECOND = 4;
const CREDITS_PER_HEARTBEAT = HEARTBEAT_SECONDS * CREDITS_PER_SECOND; // 120

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, sessionId } = req.body;
  if (!userId || !sessionId) {
    return res.status(400).json({ error: 'userId and sessionId are required' });
  }

  try {
    // Read wallet and verify session in parallel
    const [{ data: walletData }, { data: sessionData }] = await Promise.all([
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).single(),
      supabaseAdmin
        .from('sessions')
        .select('id, seconds_used, credits_used, status')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single(),
    ]);

    if (!sessionData) {
      // Session was already closed (e.g. force-ended server-side)
      return res.json({ shouldStop: true, reason: 'session_not_found', remainingCredits: 0 });
    }

    const currentCredits = walletData?.credits ?? 0;

    if (currentCredits <= 0) {
      return res.json({ shouldStop: true, reason: 'no_credits', remainingCredits: 0 });
    }

    // Bill exactly one heartbeat tick, but never go below zero
    const creditsToDeduct = Math.min(currentCredits, CREDITS_PER_HEARTBEAT);
    const newCredits = currentCredits - creditsToDeduct;
    const newSecondsUsed = (sessionData.seconds_used ?? 0) + HEARTBEAT_SECONDS;
    const newCreditsUsed = (sessionData.credits_used ?? 0) + creditsToDeduct;

    // Update wallet and session atomically (two fast writes)
    await Promise.all([
      supabaseAdmin
        .from('wallets')
        .update({ credits: newCredits })
        .eq('user_id', userId),
      supabaseAdmin
        .from('sessions')
        .update({ seconds_used: newSecondsUsed, credits_used: newCreditsUsed })
        .eq('id', sessionId),
    ]);

    const shouldStop = newCredits <= 0;
    return res.json({ remainingCredits: newCredits, shouldStop });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
