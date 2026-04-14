// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reference, userId, planName, planMinutes, credits, priceUSD } = req.body;
  if (!reference || !userId) return res.status(400).json({ status: 'failed', message: 'Missing reference or userId' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  try {
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) return res.status(500).json({ status: 'failed', message: 'Missing Paystack Secret Key' });

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${paystackSecretKey}` }
    });

    const data = await response.json();

    if (data.status && data.data.status === 'success') {
      const amountInNaira = data.data.amount / 100;
      const purchasedCredits = Number.isFinite(credits) ? Number(credits) : (planMinutes || Math.round(amountInNaira / 69.2 / 60));

      const { data: existingTransaction, error: existingTransactionError } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('user_id', userId)
        .eq('reference', reference)
        .maybeSingle();

      if (existingTransactionError) {
        console.error('Failed to check existing payment transaction:', existingTransactionError);
      }

      if (existingTransaction) {
        const { data: existingWallet } = await supabaseAdmin
          .from('wallets')
          .select('balance, credits')
          .eq('user_id', userId)
          .maybeSingle();

        return res.json({
          status: 'success',
          message: 'Payment already processed',
          data: data.data,
          newBalance: existingWallet?.balance || 0,
          newCredits: existingWallet?.credits || 0,
          alreadyProcessed: true,
        });
      }
      
      let { data: walletData } = await supabaseAdmin.from('wallets').select('balance, credits').eq('user_id', userId).maybeSingle();
        
      const currentBalance = walletData ? walletData.balance || 0 : 0;
      const currentCredits = walletData ? walletData.credits || 0 : 0;
      const newBalance = currentBalance + amountInNaira;
      const newCredits = currentCredits + purchasedCredits;
      
      const { data: savedWallet, error: walletWriteError } = await supabaseAdmin
        .from('wallets')
        .upsert({
          user_id: userId,
          balance: newBalance,
          credits: newCredits,
        }, { onConflict: 'user_id' })
        .select('balance, credits')
        .single();

      if (walletWriteError) {
        console.error('Failed to persist wallet credits:', walletWriteError);
        return res.status(500).json({ status: 'failed', message: 'Failed to persist wallet credits' });
      }
        
      const { error: transactionError } = await supabaseAdmin.from('transactions').insert({
        user_id: userId, type: 'credit', amount: amountInNaira, credits: purchasedCredits, reference: reference, description: 'Credits purchased', status: 'success', created_at: new Date()
      });

      if (transactionError) {
        console.error('Failed to record credit transaction:', transactionError);
      }

      const pName = planName || `${purchasedCredits} Credits`;
      const pMins = purchasedCredits;

      const { error: subscriptionError } = await supabaseAdmin.from('subscriptions').insert({
        user_id: userId, plan_name: pName, amount_paid: amountInNaira, credits: pMins, status: 'active', created_at: new Date()
      });

      if (subscriptionError) {
        console.error('Failed to record subscription purchase:', subscriptionError);
      }
        
      res.json({
        status: 'success',
        message: 'Payment verification successful',
        data: data.data,
        newBalance: savedWallet?.balance ?? newBalance,
        newCredits: savedWallet?.credits ?? newCredits,
      });
    } else {
      res.status(400).json({ status: 'failed', message: data.message || 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Verify payment handler error:', error);
    res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
}
