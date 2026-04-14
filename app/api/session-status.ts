// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const CREDITS_PER_SECOND = 2;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const userId = req.query.userId || req.query.id; 

  if (!userId) return res.status(400).json({ error: 'User ID is required' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError });

  try {
    const { data: walletData } = await supabaseAdmin
      .from('wallets').select('credits').eq('user_id', userId).single();

    const actualCredits = walletData?.credits || 0;

    const { data: activeSession } = await supabaseAdmin
      .from('sessions').select('*').eq('user_id', userId).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).single();

    if (!activeSession) {
      return res.json({ credits: actualCredits, secondsUsed: 0, creditsUsed: 0, remainingCredits: actualCredits, shouldStop: false });
    }

    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const creditsUsed = elapsedSeconds * CREDITS_PER_SECOND;
    
    const remainingCredits = Math.max(0, actualCredits - creditsUsed);
    let shouldStop = remainingCredits <= 0;
    let forceEnd = remainingCredits <= 0;

    res.json({ secondsUsed: elapsedSeconds, creditsUsed, remainingCredits, credits: remainingCredits, shouldStop, forceEnd });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
}
