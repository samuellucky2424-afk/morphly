import express from 'express';
import { supabaseAdmin } from '../supabase.js';

const router = express.Router();

router.post('/verify-payment', async (req, res) => {
  const { reference, userId } = req.body;
  
  if (!reference) {
    return res.status(400).json({ status: 'failed', message: 'No reference provided' });
  }
  
  if (!userId) {
    return res.status(400).json({ status: 'failed', message: 'User ID is required' });
  }

  try {
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) {
      console.warn("PAYSTACK_SECRET_KEY is missing, proceeding with mock verify");
      // MOCK verification for testing
      const mockAmount = 8000;
      return res.json({
        status: 'success',
        message: 'Mock Payment verification successful',
        data: { amount: mockAmount * 100, status: 'success' }
      });
    }

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${paystackSecretKey}`
      }
    });

    const data = await response.json();

    if (data.status && data.data.status === 'success') {
      const amountInNaira = data.data.amount / 100;
      
      // Update wallet balance correctly targeting walnuts table
      let { data: walletData } = await supabaseAdmin
        .from('wallets')
        .select('balance')
        .eq('user_id', userId)
        .single();
        
      const currentBalance = walletData ? walletData.balance : 0;
      const newBalance = currentBalance + amountInNaira;
      
      await supabaseAdmin
        .from('wallets')
        .update({ balance: newBalance })
        .eq('user_id', userId);
        
      // Record transaction
      await supabaseAdmin
        .from('transactions')
        .insert({
          user_id: userId,
          type: 'credit',
          amount: amountInNaira,
          reference: reference,
          status: 'success',
          created_at: new Date()
        });
        
      res.json({
        status: 'success',
        message: 'Payment verification successful',
        data: data.data,
        newBalance
      });
    } else {
      res.status(400).json({
        status: 'failed',
        message: data.message || 'Payment verification failed'
      });
    }
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
});

router.get('/wallet/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    let { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', userId).single();
    let { data: txs } = await supabaseAdmin.from('transactions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50);
    
    // Map DB columns to our frontend transaction structure
    const mappedTxs = (txs || []).map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      description: tx.description || (tx.type === 'credit' ? 'Balance added' : 'Session usage'),
      timestamp: tx.created_at,
    }));
    
    res.json({
      balance: wallet?.balance || 0,
      transactions: mappedTxs
    });
  } catch (error) {
    console.error('Wallet fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
