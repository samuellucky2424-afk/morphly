// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) {
    return res.status(200).json({
      balance: 0,
      credits: 0,
      transactions: [],
      warning: supabaseAdminConfigError || 'Supabase admin is not configured'
    });
  }
  
  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    const requestedUserId = req.query.userId || req.query.id;
    const userId = authResult.user.id;
    if (requestedUserId && requestedUserId !== userId) {
      return res.status(403).json({ error: 'User mismatch' });
    }

    await logRequestEvent('wallet.request', {
      method: req.method,
      path: '/api/wallet',
      userId,
    });

    let { data: wallet } = await supabaseAdmin.from('wallets').select('balance, credits').eq('user_id', userId).single();
    let { data: txs } = await supabaseAdmin.from('transactions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50);
    
    // Map DB columns to our frontend transaction structure
    const mappedTxs = (txs || []).map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      credits: tx.credits || 0,
      description: tx.description || (tx.type === 'credit' ? 'Credits purchased' : 'Session usage'),
      timestamp: tx.created_at,
    }));
    
    res.json({
      balance: wallet?.balance || 0,
      credits: wallet?.credits || 0,
      transactions: mappedTxs
    });
  } catch (error) {
    await logErrorEvent('wallet.exception', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
