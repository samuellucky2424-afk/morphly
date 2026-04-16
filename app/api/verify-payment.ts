// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reference, userId, credits, priceUSD } = req.body;
  if (!reference || !userId) return res.status(400).json({ status: 'failed', message: 'Missing reference or userId' });

  try {
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) return res.status(500).json({ status: 'failed', message: 'Missing Paystack Secret Key' });

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${paystackSecretKey}` }
    });

    const data = await response.json();

    if (data.status && data.data.status === 'success') {
      const amountPaidNGN = data.data.amount / 100;
      
      // Add credits to user's wallet
      const creditsToAdd = credits || Math.round(amountPaidNGN / 30); // fallback calculation
      
      let { data: walletData } = await supabaseAdmin.from('wallets').select('balance, credits').eq('user_id', userId).single();
        
      const currentCredits = walletData?.credits || 0;
      const newCredits = currentCredits + creditsToAdd;
      
      await supabaseAdmin.from('wallets').update({ credits: newCredits }).eq('user_id', userId);
        
      await supabaseAdmin.from('transactions').insert({
        user_id: userId, 
        type: 'credit', 
        amount: amountPaidNGN, 
        credits: creditsToAdd,
        reference: reference, 
        status: 'success', 
        created_at: new Date()
      });

      const planName = credits ? `${credits} Credits` : 'Credit Purchase';

      await supabaseAdmin.from('subscriptions').insert({
        user_id: userId, 
        plan_name: planName, 
        amount_paid: amountPaidNGN, 
        credits: creditsToAdd, 
        status: 'active', 
        created_at: new Date()
      });
        
      res.json({ status: 'success', message: 'Payment verification successful', data: data.data, creditsAdded: creditsToAdd, newCredits });
    } else {
      res.status(400).json({ status: 'failed', message: data.message || 'Payment verification failed' });
    }
  } catch (error) {
    res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}
