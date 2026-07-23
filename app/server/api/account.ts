// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import { logErrorEvent, logRequestEvent } from '../../../shared/backend-logger.js';

const CURRENT_ONBOARDING_VERSION = 1;
const ACCOUNT_FIELDS = [
  'onboarding_completed',
  'onboarding_completed_at',
  'onboarding_skipped_at',
  'onboarding_version',
].join(',');

function serializeOnboarding(profile) {
  return {
    completed: Boolean(profile?.onboarding_completed),
    completedAt: profile?.onboarding_completed_at || null,
    skippedAt: profile?.onboarding_skipped_at || null,
    version: Number(profile?.onboarding_version || CURRENT_ONBOARDING_VERSION),
    currentVersion: CURRENT_ONBOARDING_VERSION,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) return res.status(authResult.status).json({ error: authResult.error });
    const userId = authResult.user.id;

    if (req.method === 'POST' && req.body?.action === 'claim-signup-welcome') {
      const { data, error } = await supabaseAdmin.rpc('morphly_claim_signup_bonus_welcome', {
        p_user: userId,
      });
      if (error) throw error;
      return res.json({ showWelcome: Boolean(data) });
    }

    if (req.method === 'POST') {
      const action = String(req.body?.action || '').trim();
      const now = new Date().toISOString();
      let update;

      if (action === 'complete') {
        update = {
          onboarding_completed: true,
          onboarding_completed_at: now,
          onboarding_skipped_at: null,
          onboarding_version: CURRENT_ONBOARDING_VERSION,
          updated_at: now,
        };
      } else if (action === 'skip') {
        update = {
          onboarding_completed: true,
          onboarding_completed_at: now,
          onboarding_skipped_at: now,
          onboarding_version: CURRENT_ONBOARDING_VERSION,
          updated_at: now,
        };
      } else if (action === 'restart') {
        update = {
          onboarding_completed: false,
          onboarding_completed_at: null,
          onboarding_skipped_at: null,
          onboarding_version: CURRENT_ONBOARDING_VERSION,
          updated_at: now,
        };
      } else {
        return res.status(400).json({ error: 'Unsupported account action' });
      }

      const { data, error } = await supabaseAdmin
        .from('users')
        .update(update)
        .eq('id', userId)
        .select(ACCOUNT_FIELDS)
        .single();
      if (error) throw error;

      await logRequestEvent('account.onboarding_updated', {
        userId,
        action,
        onboardingVersion: CURRENT_ONBOARDING_VERSION,
      });

      return res.json({ onboarding: serializeOnboarding(data) });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .select(ACCOUNT_FIELDS)
      .eq('id', userId)
      .single();
    if (error) throw error;

    return res.json({ onboarding: serializeOnboarding(data) });
  } catch (error) {
    await logErrorEvent('account.exception', error, { method: req.method });
    return res.status(500).json({ error: 'Failed to load account onboarding state' });
  }
}
