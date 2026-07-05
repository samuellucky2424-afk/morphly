import { authenticateRequestUser } from './admin-auth.js';
import { logErrorEvent, logRequestEvent } from './backend-logger.js';

function isMissingColumnError(error) {
  const message = String(error?.message || error?.details || '');
  return error?.code === 'PGRST204' || /column .* does not exist|could not find .* column/i.test(message);
}

function isDuplicateWalletError(error) {
  const message = String(error?.message || error?.details || '');
  return error?.code === '23505' || /duplicate key value|already exists/i.test(message);
}

async function ensurePublicUser(supabaseAdmin, user) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert(
      {
        id: user.id,
        email: user.email || '',
      },
      { onConflict: 'id' },
    );

  if (error) {
    throw error;
  }
}

async function getExistingWallet(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function insertMissingWallet(supabaseAdmin, userId) {
  const insertAttempts = [
    { user_id: userId, credits: 0, balance: 0 },
    { user_id: userId, credits: 0 },
    { user_id: userId, balance: 0 },
    { user_id: userId },
  ];

  let lastError = null;

  for (const payload of insertAttempts) {
    const { error } = await supabaseAdmin.from('wallets').insert(payload);

    if (!error) {
      return true;
    }

    if (isDuplicateWalletError(error)) {
      return false;
    }

    if (isMissingColumnError(error)) {
      lastError = error;
      continue;
    }

    throw error;
  }

  throw lastError || new Error('Unable to create wallet row');
}

export async function ensureUserWallet(supabaseAdmin, user) {
  await ensurePublicUser(supabaseAdmin, user);

  const existingWallet = await getExistingWallet(supabaseAdmin, user.id);
  if (existingWallet) {
    return { walletCreated: false };
  }

  const walletCreated = await insertMissingWallet(supabaseAdmin, user.id);
  return { walletCreated };
}

export function createEnsureUserWalletHandler({ supabaseAdmin, supabaseAdminConfigError }) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!supabaseAdmin) {
      return res.status(503).json({
        error: supabaseAdminConfigError || 'Supabase admin is not configured',
      });
    }

    try {
      const authResult = await authenticateRequestUser(req, supabaseAdmin);
      if (authResult.error) {
        return res.status(authResult.status).json({ error: authResult.error });
      }

      await logRequestEvent('ensure-user-wallet.request', {
        method: req.method,
        path: '/api/ensure-user-wallet',
        userId: authResult.user.id,
      });

      const result = await ensureUserWallet(supabaseAdmin, authResult.user);

      return res.json({
        ok: true,
        userId: authResult.user.id,
        ...result,
      });
    } catch (error) {
      await logErrorEvent('ensure-user-wallet.exception', error);
      return res.status(500).json({ error: 'Failed to set up user wallet' });
    }
  };
}
