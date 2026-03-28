// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

const PRICE_PER_SECOND = 69.2;
const MAX_SESSION_DURATION = 600;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // Actually, standardizing parameterized requests /api/session-status?userId=xxx because Vercel doesn't do /api/session-status/:userId by default without a rewrite.
  // Wait, I will just accept ?userId=...
  const userId = req.query.userId || req.query.id; 

  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    const { data: walletData } = await supabaseAdmin
      .from('wallets').select('balance').eq('user_id', userId).single();

    const actualBalance = walletData ? walletData.balance : 0;

    const { data: activeSession } = await supabaseAdmin
      .from('sessions').select('*').eq('user_id', userId).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).single();

    if (!activeSession) {
      return res.json({ balance: actualBalance, secondsUsed: 0, cost: 0, remainingBalance: actualBalance, shouldStop: false });
    }

    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const cost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
    
    const remainingBalance = Math.max(0, actualBalance - cost);
    let shouldStop = (remainingBalance <= 0) || (elapsedSeconds > MAX_SESSION_DURATION);
    let forceEnd = remainingBalance <= 0;

    res.json({ secondsUsed: elapsedSeconds, cost, remainingBalance, balance: remainingBalance, shouldStop, forceEnd });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
}
