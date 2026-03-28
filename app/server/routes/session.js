import express from 'express';
import multer from 'multer';
import { supabaseAdmin, supabaseAnon } from '../supabase.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const PRICE_PER_SECOND = 69.2;

const activeSessions = new Map();

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

    let userData = walletData;

    if (userData.balance <= 0) {
      return res.json({ allowed: false, error: 'Insufficient balance' });
    }

    activeSessions.set(userId, {
      startTime: Date.now(),
      balance: userData.balance,
      isActive: true
    });

    res.json({ 
      allowed: true, 
      token: process.env.DECART_API_KEY 
    });
  } catch (error) {
    console.error('Start session error:', error);
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
});

router.get('/session-status/:userId', (req, res) => {
  const { userId } = req.params;
  const currentSession = activeSessions.get(userId);

  if (!currentSession || !currentSession.isActive || !currentSession.startTime) {
    return res.json({ 
      balance: currentSession ? currentSession.balance : 0,
      secondsUsed: 0,
      cost: 0,
      shouldStop: false
    });
  }

  const elapsedSeconds = Math.floor((Date.now() - currentSession.startTime) / 1000);
  const totalCost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
  let remainingBalance = currentSession.balance - totalCost;
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
});

router.post('/deduct-balance', async (req, res) => {
  try {
    const { userId } = req.body;
    const currentSession = activeSessions.get(userId);

    if (!currentSession || !currentSession.isActive || !currentSession.startTime) {
      return res.status(400).json({ error: 'No active session' });
    }

    const elapsedSeconds = Math.floor((Date.now() - currentSession.startTime) / 1000);
    const totalCost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
    let remainingBalance = currentSession.balance - totalCost;

    if (remainingBalance <= 0) {
      remainingBalance = 0;
    }

    // Update balance in database
    await supabaseAdmin
      .from('wallets')
      .update({ balance: remainingBalance })
      .eq('user_id', userId);

    // Log session
    await supabaseAdmin.from('sessions').insert({
      user_id: userId,
      start_time: new Date(currentSession.startTime),
      end_time: new Date(),
      cost: totalCost,
      seconds_used: elapsedSeconds
    });

    // Insert debit transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      type: 'debit',
      amount: totalCost,
      status: 'success',
      created_at: new Date()
    });

    activeSessions.delete(userId);

    res.json({ success: true, cost: totalCost, newBalance: remainingBalance });
  } catch (error) {
    console.error('Deduct balance error:', error);
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
