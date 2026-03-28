import express from 'express';
import multer from 'multer';
import { supabaseAdmin, supabaseAnon } from '../supabase.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const PRICE_PER_SECOND = 69.2;
const MAX_SESSION_DURATION = 600;

// Helper to securely calculate and close a session with cost clamping
async function closeActiveSession(userId, activeSession) {
  try {
    // 1. Fetch real wallet balance
    const { data: walletData } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .single();

    const actualBalance = walletData ? walletData.balance : 0;

    // 2. Safe Cost calculation
    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const cost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
    
    const finalCost = Math.min(actualBalance, cost);
    const newBalance = Math.max(0, actualBalance - finalCost);

    // 3. Atomically End the Session
    await supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(),
        cost: finalCost,
        seconds_used: elapsedSeconds,
        status: 'ended'
      })
      .eq('id', activeSession.id)
      .eq('status', 'active'); // Ensure we only touch it if it's currently active to prevent double-billing

    // 4. Record new wallet state
    await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('user_id', userId);

    // 5. Insert ONE debit transaction securely
    if (finalCost > 0) {
      await supabaseAdmin.from('transactions').insert({
        user_id: userId,
        type: 'debit',
        amount: finalCost,
        status: 'success',
        created_at: new Date()
      });
    }

    // Logging for integrity and debugging
    console.log(`[SESSION END] User: ${userId} | Session: ${activeSession.id} | Seconds: ${elapsedSeconds} | Cost: ${finalCost} | New Balance: ${newBalance}`);

    return { success: true, deducted: finalCost, remainingBalance: newBalance };
  } catch (err) {
    console.error(`[SESSION END ERROR] Failed to close session ${activeSession.id}:`, err);
    return { success: false, message: 'Internal error closing session' };
  }
}

router.post('/start-session', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ allowed: false, error: 'User ID is required' });
    }
    
    // Check for any existing active session immediately to prevent overlapping costs
    const { data: existingActiveSessions } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (existingActiveSessions && existingActiveSessions.length > 0) {
      // Loop robustly just in case corrupt rows exist, though typically only 1
      for (const session of existingActiveSessions) {
        await closeActiveSession(userId, session);
      }
    }

    // Now re-fetch genuine wallet balance after ending ghosts
    const { data: freshWallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .single();

    if (!freshWallet || freshWallet.balance <= 0) {
      return res.json({ allowed: false, error: 'Insufficient balance' });
    }

    // Create precisely one new session in "active" state
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

    const { data: walletData } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .single();

    const actualBalance = walletData ? walletData.balance : 0;

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
        balance: actualBalance, // Retained for compatibility during non-active UI reads
        secondsUsed: 0,
        cost: 0,
        remainingBalance: actualBalance,
        shouldStop: false
      });
    }

    const startTime = new Date(activeSession.start_time).getTime();
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const cost = Math.round(elapsedSeconds * PRICE_PER_SECOND);
    
    const remainingBalance = Math.max(0, actualBalance - cost);
    let shouldStop = (remainingBalance <= 0) || (elapsedSeconds > MAX_SESSION_DURATION);

    res.json({
      secondsUsed: elapsedSeconds,
      cost,
      remainingBalance,
      balance: remainingBalance, // For frontend legacy
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
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const { data: activeSession } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!activeSession) {
      return res.json({ success: false, message: 'No active session' });
    }

    // Defer purely to our standardized closure routine
    const endResult = await closeActiveSession(userId, activeSession);
    
    if (endResult.success) {
      res.json(endResult);
    } else {
      res.status(500).json(endResult);
    }
  } catch (error) {
    console.error('End session route error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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

    try {
      await supabaseAdmin.storage.createBucket('reference-images', { public: true });
    } catch (bucketError) {}

    const { data, error: uploadError } = await supabaseAdmin
      .storage
      .from('reference-images')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (uploadError) {
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
