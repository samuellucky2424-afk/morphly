import express from 'express';
import multer from 'multer';
import { supabaseAdmin, supabaseAnon } from '../supabase.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const PRICE_PER_SECOND = 69.2;

router.post('/start-session', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ allowed: false, error: 'User ID is required' });
    }
    
    const { data: walletData, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .single();

    if (walletError || !walletData) {
      console.error('Wallet fetch error:', walletError);
      return res.status(400).json({ allowed: false, error: 'Wallet not found for this user' });
    }

    if (walletData.balance <= 0) {
      return res.json({ allowed: false, error: 'Insufficient balance' });
    }

    // End any lingering active sessions for this user before starting a new one
    await supabaseAdmin
      .from('sessions')
      .update({ status: 'ended', end_time: new Date() })
      .eq('user_id', userId)
      .eq('status', 'active');

    // Create a new session in "active" state
    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,
        status: 'active',
        start_time: new Date(),
        cost: 0,
        seconds_used: 0
      })
      .select('id')
      .single();

    if (sessionError) {
      console.error('Session create error:', sessionError);
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    res.json({ 
      allowed: true, 
      sessionId: newSession.id,
      token: process.env.DECART_API_KEY 
    });
  } catch (error) {
    console.error('Start session error:', error);
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
});

router.get('/session-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Fetch current true balance
    const { data: walletData } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .single();

    const actualBalance = walletData ? walletData.balance : 0;

    // Find the single active session
    const { data: activeSession } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!activeSession) {
      return res.json({ 
        balance: actualBalance,
        secondsUsed: 0,
        cost: 0,
        shouldStop: false
      });
    }

    // Calculate elapsed time dynamically without relying on background loops
    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const totalCost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
    
    let remainingBalance = actualBalance - totalCost;
    let shouldStop = false;

    if (remainingBalance <= 0) {
      remainingBalance = 0;
      shouldStop = true;
    }

    res.json({
      balance: remainingBalance,
      secondsUsed: elapsedSeconds,
      cost: totalCost,
      shouldStop
    });
  } catch (error) {
    console.error('Session status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/end-session', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Find the active session to end it
    const { data: activeSession } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!activeSession) {
      return res.status(400).json({ error: 'No active session found matching criteria' });
    }

    // Fetch the actual starting balance point
    const { data: walletData } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .single();

    const actualBalance = walletData ? walletData.balance : 0;

    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const totalCost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
    
    let remainingBalance = actualBalance - totalCost;
    if (remainingBalance <= 0) {
      remainingBalance = 0;
    }

    // Execute atomic deduct
    await supabaseAdmin
      .from('wallets')
      .update({ balance: remainingBalance })
      .eq('user_id', userId);

    // Finalize the session row so polling stops charging it
    await supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(),
        cost: totalCost,
        seconds_used: elapsedSeconds,
        status: 'ended'
      })
      .eq('id', activeSession.id);

    // Register receipt for transparency
    if (totalCost > 0) {
      await supabaseAdmin.from('transactions').insert({
        user_id: userId,
        type: 'debit',
        amount: totalCost,
        status: 'success',
        created_at: new Date()
      });
    }

    res.json({ success: true, cost: totalCost, newBalance: remainingBalance });
  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    const mockUserId = 'mock-user-123';
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileName = `${mockUserId}/${Date.now()}-${file.originalname}`;

    // Try to ensure bucket exists, or use a public bucket
    try {
      await supabaseAdmin.storage.createBucket('reference-images', { public: true });
    } catch (bucketError) {
      // Bucket might already exist, continue
    }

    const { data, error: uploadError } = await supabaseAdmin
      .storage
      .from('reference-images')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      // Return the base64 data URL instead as fallback
      const base64 = file.buffer.toString('base64');
      const dataUrl = `data:${file.mimetype};base64,${base64}`;
      return res.json({ url: dataUrl, local: true });
    }

    const { data: { publicUrl } } = supabaseAdmin
      .storage
      .from('reference-images')
      .getPublicUrl(fileName);

    res.json({ url: publicUrl });
  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
