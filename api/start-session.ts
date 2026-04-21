// @ts-nocheck
import { supabaseAdmin } from './supabase.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ allowed: false, error: 'User ID is required' });

    // Fetch orphaned sessions and wallet in parallel
    const [{ data: existingActiveSessions }, { data: walletNow }] = await Promise.all([
      supabaseAdmin.from('sessions').select('id, start_time').eq('user_id', userId).eq('status', 'active'),
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).single(),
    ]);

    // Bill and close all orphaned sessions in one parallel batch
    let runningCredits = walletNow?.credits ?? 0;
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      const now = Date.now();
      let totalDeduction = 0;
      const sessionCalcs = existingActiveSessions.map(session => {
        const elapsedSeconds = Math.floor((now - new Date(session.start_time).getTime()) / 1000);
        const billableSeconds = Math.min(elapsedSeconds, MAX_BILLABLE_SECONDS);
        const creditsToDeduct = billableSeconds * CREDITS_PER_SECOND;
        totalDeduction += creditsToDeduct;
        return { id: session.id, billableSeconds, creditsToDeduct };
      });
      const actualDeduction = Math.min(runningCredits, totalDeduction);
      runningCredits = runningCredits - actualDeduction;
      // Close all sessions + update wallet in one parallel round-trip
      await Promise.all([
        ...sessionCalcs.map(s =>
          supabaseAdmin.from('sessions')
            .update({ end_time: new Date(), status: 'ended', seconds_used: s.billableSeconds, cost: s.creditsToDeduct })
            .eq('id', s.id).eq('status', 'active'),
        ),
        actualDeduction > 0
          ? supabaseAdmin.from('wallets').update({ credits: runningCredits }).eq('user_id', userId)
          : Promise.resolve(),
      ]);
    }

    // Use the already-fetched (and post-billing-adjusted) credit balance
    const userCredits = runningCredits;
    if (userCredits <= 0) {
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    // Declare maxSeconds BEFORE the insert so it is stored correctly in the DB.
    // (Previously it was declared after the insert, causing max_seconds = NULL
    //  which made closeActiveSession fall back to wiping the entire balance.)
    const maxSeconds = Math.floor(userCredits / CREDITS_PER_SECOND);

    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,
        status: 'active',
        start_time: new Date(),
        cost: 0,
        seconds_used: 0,
      }).select('id').single();

    if (sessionError) return res.status(500).json({ allowed: false, error: 'Failed to create session' });

    res.json({ allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds, token: process.env.DECART_API_KEY });
  } catch (error) {
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}
