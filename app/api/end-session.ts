// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;

async function closeActiveSession(userId, activeSession) {
  try {
    const { data: walletData } = await supabaseAdmin
      .from('wallets').select('credits').eq('user_id', userId).single();

    const actualCredits = walletData?.credits || 0;
    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

    const storedMax = activeSession.max_seconds;
    const maxSeconds = typeof storedMax === 'number' && storedMax > 0
      ? storedMax
      : Math.min(Math.floor(actualCredits / CREDITS_PER_SECOND), MAX_BILLABLE_SECONDS);
    const billableSeconds = Math.min(elapsedSeconds, maxSeconds);
    const creditsUsed = billableSeconds * CREDITS_PER_SECOND;

    const finalCreditsUsed = Math.min(actualCredits, creditsUsed);
    const newCredits = Math.max(0, actualCredits - finalCreditsUsed);

    await supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(),
        credits_used: finalCreditsUsed,
        seconds_used: billableSeconds,
        status: 'ended'
      }).eq('id', activeSession.id).eq('status', 'active');

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
    return { success: false, message: 'Internal error closing session' };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ success: false, error: supabaseAdminConfigError });

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

    const { data: activeSession } = await supabaseAdmin
      .from('sessions').select('*').eq('user_id', userId).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).single();

    if (!activeSession) return res.json({ success: false, message: 'No active session' });

    const endResult = await closeActiveSession(userId, activeSession);
    res.status(endResult.success ? 200 : 500).json(endResult);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
