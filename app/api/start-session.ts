// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const CREDITS_PER_SECOND = 2;

async function closeActiveSession(userId, activeSession) {
  try {
    const { data: walletData } = await supabaseAdmin
      .from('wallets').select('credits').eq('user_id', userId).single();

    const actualCredits = walletData?.credits || 0;
    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const creditsUsed = elapsedSeconds * CREDITS_PER_SECOND;
    
    const finalCreditsUsed = Math.min(actualCredits, creditsUsed);
    const newCredits = Math.max(0, actualCredits - finalCreditsUsed);

    await supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(),
        credits_used: finalCreditsUsed,
        seconds_used: elapsedSeconds,
        status: 'ended'
      })
      .eq('id', activeSession.id).eq('status', 'active');

    await supabaseAdmin
      .from('wallets')
      .update({ credits: newCredits })
      .eq('user_id', userId);

    if (finalCreditsUsed > 0) {
      await supabaseAdmin.from('transactions').insert({
        user_id: userId, 
        type: 'debit', 
        amount: 0, 
        credits: finalCreditsUsed, 
        description: 'Session ended - credits deducted',
        status: 'success', 
        created_at: new Date()
      });
    }

    return { success: true, creditsDeducted: finalCreditsUsed, remainingCredits: newCredits };
  } catch (err) {
    console.error('Failed to close session:', err);
    return { success: false, message: 'Internal error closing session' };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ allowed: false, error: supabaseAdminConfigError });

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ allowed: false, error: 'User ID is required' });

    const { data: existingActiveSessions } = await supabaseAdmin
      .from('sessions').select('*').eq('user_id', userId).eq('status', 'active');

    if (existingActiveSessions && existingActiveSessions.length > 0) {
      for (const session of existingActiveSessions) {
        await closeActiveSession(userId, session);
      }
    }

    const { data: freshWallet } = await supabaseAdmin
      .from('wallets').select('credits').eq('user_id', userId).single();

    const userCredits = freshWallet?.credits || 0;
    if (userCredits <= 0) {
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId, 
        status: 'active', 
        start_time: new Date(), 
        credits_used: 0, 
        seconds_used: 0
      }).select('id').single();

    if (sessionError) return res.status(500).json({ allowed: false, error: 'Failed to create session' });

    // Calculate max session duration based on credits (2 credits/second)
    const maxSeconds = Math.floor(userCredits / CREDITS_PER_SECOND);

    res.json({ allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds, token: process.env.DECART_API_KEY });
  } catch (error) {
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}
