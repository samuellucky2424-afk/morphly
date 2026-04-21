// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

// Credits are billed in real-time by /api/heartbeat (every 30 s while
// the client is actively streaming). This endpoint only closes the session
// record and returns the current wallet balance. No additional deduction
// happens here — so orphaned sessions and normal stops are both safe.
async function closeSession(sessionId, userId) {
  await supabaseAdmin
    .from('sessions')
    .update({ end_time: new Date(), status: 'ended' })
    .eq('id', sessionId)
    .eq('status', 'active');

  const { data: walletData } = await supabaseAdmin
    .from('wallets').select('credits').eq('user_id', userId).single();

  return walletData?.credits ?? 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

    const { data: activeSession } = await supabaseAdmin
      .from('sessions').select('id').eq('user_id', userId).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).single();

    if (!activeSession) return res.json({ success: true, message: 'No active session' });

    const remainingCredits = await closeSession(activeSession.id, userId);
    return res.json({ success: true, remainingCredits });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
