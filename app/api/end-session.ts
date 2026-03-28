// @ts-nocheck
import { supabaseAdmin } from './supabase';

const PRICE_PER_SECOND = 69.2;

async function closeActiveSession(userId, activeSession) {
  try {
    const { data: walletData } = await supabaseAdmin
      .from('wallets').select('balance').eq('user_id', userId).single();

    const actualBalance = walletData ? walletData.balance : 0;
    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const cost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
    
    const finalCost = Math.min(actualBalance, cost);
    const newBalance = Math.max(0, actualBalance - finalCost);

    await supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(), cost: finalCost, seconds_used: elapsedSeconds, status: 'ended'
      }).eq('id', activeSession.id).eq('status', 'active');

    await supabaseAdmin
      .from('wallets').update({ balance: newBalance }).eq('user_id', userId);

    if (finalCost > 0) {
      await supabaseAdmin.from('transactions').insert({
        user_id: userId, type: 'debit', amount: finalCost, status: 'success', created_at: new Date()
      });
    }

    return { success: true, deducted: finalCost, remainingBalance: newBalance };
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
