// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || req.query.id;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    const { data: walletData } = await supabaseAdmin
      .from('wallets').select('credits').eq('user_id', userId).single();

    const credits = walletData?.credits ?? 0;
    const shouldStop = credits <= 0;

    return res.json({ credits, remainingCredits: credits, shouldStop, forceEnd: shouldStop });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}
