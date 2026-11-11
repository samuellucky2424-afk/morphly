// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import { settleRealtimeVideo } from '../realtime-billing.js';
import { PROVIDER_CREDENTIAL_WINDOW_SECONDS } from '../firebase-realtime-billing.js';
import { createXmaxTemporaryKey } from './start-session.ts';
import { revokeProviderSession } from '../provider-revocation.js';
import { rateLimit } from '../request-rate-limit.js';

const HEARTBEAT_SECONDS = 30;
const CREDITS_PER_SECOND = 2;
const MAX_SECONDS_PER_HEARTBEAT = 60;

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? credits : 0;
}

function normalizeSeconds(value) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

function normalizeHeartbeatSeconds(value) {
  const seconds = Number(value ?? HEARTBEAT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return Math.min(Math.floor(seconds), MAX_SECONDS_PER_HEARTBEAT);
}

function isMissingUsageRpc(error) {
  const message = String(error?.message || error?.details || error?.hint || '');
  return ['PGRST202', '42883'].includes(error?.code) ||
    /record_ai_session_usage|schema cache|function .* does not exist/i.test(message);
}

// Once the RPC is known to be missing (404), stop paying for a guaranteed
// failed round-trip on every heartbeat and go straight to the legacy path.
let usageRpcUnavailable = false;

async function updateSessionUsage(sessionId, secondsUsed, creditsUsed) {
  const updateWithCost = await supabaseAdmin
    .from('sessions')
    .update({ seconds_used: secondsUsed, cost: creditsUsed })
    .eq('id', sessionId)
    .eq('status', 'active');

  if (!updateWithCost.error) {
    return updateWithCost;
  }

  const message = String(updateWithCost.error?.message || updateWithCost.error?.details || '');
  if (updateWithCost.error?.code !== 'PGRST204' && !/cost/i.test(message)) {
    return updateWithCost;
  }

  return supabaseAdmin
    .from('sessions')
    .update({ seconds_used: secondsUsed, credits_used: creditsUsed })
    .eq('id', sessionId)
    .eq('status', 'active');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError });

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    const userId = authResult.user.id;
    const requestedUserId = req.body?.userId;
    const sessionId = req.body?.sessionId;
    if (requestedUserId && requestedUserId !== userId) {
      return res.status(403).json({ error: 'User mismatch' });
    }
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    if (!rateLimit(`heartbeat:${userId}`, { limit: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many usage updates. Wait a moment and try again.' });
    }
    if (req.body?.billingVersion === 2) {
      const result = await settleRealtimeVideo(supabaseAdmin, userId, sessionId, false, { extend: req.body?.acceptRenewal === true });
      if (result?.ended) await revokeProviderSession({ id: sessionId, provider: result.provider, provider_key_id: result.providerKeyId, provider_live_id: result.providerLiveId });
      if (result?.renewalDue && req.body?.acceptRenewal === true && !result.shouldStop && result.provider === 'xmax') {
        const extended = await supabaseAdmin.rpc('reserve_realtime_video', {
          p_user: userId, p_session: sessionId, p_window: PROVIDER_CREDENTIAL_WINDOW_SECONDS,
        });
        const addedSeconds = Number(extended.data?.reservedSeconds);
        const minted = extended.error || addedSeconds < 1 ? null : await createXmaxTemporaryKey({ apiKey: process.env.XMAX_API_KEY?.trim(), maxSeconds: addedSeconds });
        if (minted?.token) {
          await supabaseAdmin.from('sessions').update({ provider_key_id: minted.token, credential_expires_at: minted.expiresAt }).eq('id', sessionId);
          result.renewedToken = minted.token;
          result.expiresAt = minted.expiresAt;
          result.remainingCredits = extended.data?.remainingCredits ?? result.remainingCredits;
        }
      }
      return res.json(result);
    }
    const secondsDelta = normalizeHeartbeatSeconds(req.body?.secondsDelta ?? req.body?.seconds);
    if (secondsDelta <= 0) {
      return res.status(400).json({ error: 'secondsDelta must be greater than 0' });
    }

    // Legacy sessions still settle through the atomic usage RPC. There is no
    // fallback that records seconds without debiting the wallet.
    if (!usageRpcUnavailable) {
      const usageRpc = await supabaseAdmin.rpc('record_ai_session_usage', {
        p_user: userId,
        p_session: sessionId,
        p_seconds_delta: secondsDelta,
      });

      if (!usageRpc.error) {
        return res.json(usageRpc.data);
      }

      if (!isMissingUsageRpc(usageRpc.error)) {
        throw usageRpc.error;
      }

      usageRpcUnavailable = true;
    }

    return res.status(503).json({ error: 'Realtime billing is temporarily unavailable. Please try again later.' });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
