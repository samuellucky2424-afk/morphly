// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const CREDITS_PER_SECOND = 2;
// Hard ceiling: one session can never bill more than 2 hours,
// protecting users whose app crashed and left an orphaned session.
const MAX_BILLABLE_SECONDS = 7200;

// Bills the exact seconds streamed (start_time → now), capped at max_seconds.
async function billAndCloseSession(session, userId) {
  const { data: walletData } = await supabaseAdmin
    .from('wallets').select('credits').eq('user_id', userId).single();

  const currentCredits = walletData?.credits ?? 0;

  const elapsedSeconds = Math.floor(
    (Date.now() - new Date(session.start_time).getTime()) / 1000,
  );

  // Use stored max_seconds so a crashed session cannot charge more than
  // the user could afford when they clicked Start.
  const storedMax = typeof session.max_seconds === 'number' && session.max_seconds > 0
    ? session.max_seconds
    : MAX_BILLABLE_SECONDS;
  const billableSeconds = Math.min(elapsedSeconds, storedMax);
  const creditsToDeduct = Math.min(currentCredits, billableSeconds * CREDITS_PER_SECOND);
  const newCredits = currentCredits - creditsToDeduct;

  await Promise.all([
    supabaseAdmin
      .from('sessions')
      .update({
        end_time: new Date(),
        status: 'ended',
        seconds_used: billableSeconds,
        credits_used: creditsToDeduct,
      })
      .eq('id', session.id)
      .eq('status', 'active'),
    creditsToDeduct > 0
      ? supabaseAdmin.from('wallets').update({ credits: newCredits }).eq('user_id', userId)
      : Promise.resolve(),
  ]);

  return newCredits;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabaseAdmin) return res.status(503).json({ success: false, error: supabaseAdminConfigError });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

    const { data: activeSession } = await supabaseAdmin
      .from('sessions')
      .select('id, start_time, max_seconds')
      .eq('user_id', userId).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).single();

    if (!activeSession) return res.json({ success: true, message: 'No active session', remainingCredits: null });

    const remainingCredits = await billAndCloseSession(activeSession, userId);
    return res.json({ success: true, remainingCredits });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
