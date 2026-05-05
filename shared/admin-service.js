import { listCreditPackages, updateCreditPackages } from './credit-packages.js';

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? Math.max(0, Math.round(credits)) : 0;
}

async function listAllAuthUsers(supabaseAdmin) {
  const users = [];
  let page = 1;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });

    if (error) {
      throw error;
    }

    const batch = data?.users || [];
    users.push(...batch);

    if (batch.length < 1000) {
      break;
    }

    page += 1;
  }

  return users;
}

function normalizeAmount(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

export async function getAdminOverview(supabaseAdmin) {
  const authUsers = await listAllAuthUsers(supabaseAdmin);
  const userIds = authUsers.map((user) => user.id);

  if (userIds.length === 0) {
    return {
      totalUsers: 0,
      blockedUsers: 0,
      totalCredits: 0,
      revenueNGN: 0,
      activeSessions: 0,
    };
  }

  const [walletsResult, activeSessionsResult, transactionsResult] = await Promise.all([
    supabaseAdmin.from('wallets').select('credits').in('user_id', userIds),
    supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabaseAdmin.from('transactions').select('amount, type, status').in('user_id', userIds),
  ]);

  if (walletsResult.error) {
    throw walletsResult.error;
  }

  if (activeSessionsResult.error) {
    throw activeSessionsResult.error;
  }

  if (transactionsResult.error) {
    throw transactionsResult.error;
  }

  const totalCredits = (walletsResult.data || []).reduce(
    (sum, wallet) => sum + normalizeCredits(wallet.credits),
    0,
  );

  const revenueNGN = (transactionsResult.data || []).reduce((sum, transaction) => {
    if (transaction.type !== 'credit' || transaction.status !== 'success') {
      return sum;
    }

    return sum + normalizeAmount(transaction.amount);
  }, 0);

  return {
    totalUsers: authUsers.length,
    blockedUsers: 0,
    totalCredits,
    revenueNGN,
    activeSessions: activeSessionsResult.count || 0,
  };
}

export async function listAdminUsers(supabaseAdmin) {
  const authUsers = await listAllAuthUsers(supabaseAdmin);
  const userIds = authUsers.map((user) => user.id);

  if (userIds.length === 0) {
    return [];
  }

  const [walletsResult, adminsResult] = await Promise.all([
    supabaseAdmin.from('wallets').select('user_id, credits').in('user_id', userIds),
    supabaseAdmin.from('admin_users').select('user_id, role').eq('is_active', true).in('user_id', userIds),
  ]);

  if (walletsResult.error) {
    throw walletsResult.error;
  }

  if (adminsResult.error) {
    throw adminsResult.error;
  }

  const walletByUserId = new Map((walletsResult.data || []).map((wallet) => [wallet.user_id, normalizeCredits(wallet.credits)]));
  const adminByUserId = new Map((adminsResult.data || []).map((admin) => [admin.user_id, admin.role]));

  return authUsers
    .map((authUser) => ({
      id: authUser.id,
      email: authUser.email || '',
      name: authUser.user_metadata?.name || authUser.email?.split('@')[0] || 'User',
      createdAt: authUser.created_at || null,
      lastSignInAt: authUser.last_sign_in_at || null,
      credits: walletByUserId.get(authUser.id) || 0,
      isAdmin: adminByUserId.has(authUser.id),
      adminRole: adminByUserId.get(authUser.id) || null,
    }))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

export async function addCreditsToUser(supabaseAdmin, payload) {
  const userId = String(payload.userId || '').trim();
  const creditsToAdd = normalizeCredits(payload.creditsToAdd);
  const adminUserId = String(payload.adminUserId || '').trim();

  if (!userId) {
    throw new Error('userId is required');
  }

  if (!(creditsToAdd > 0)) {
    throw new Error('creditsToAdd must be a positive integer');
  }

  const { data: walletData, error: walletError } = await supabaseAdmin
    .from('wallets')
    .select('credits')
    .eq('user_id', userId)
    .maybeSingle();

  if (walletError) {
    throw walletError;
  }

  const currentCredits = normalizeCredits(walletData?.credits);
  const newCredits = currentCredits + creditsToAdd;
  const reference = `admin_credit_${userId}_${Date.now()}`;
  const description = adminUserId
    ? `Admin credit adjustment by ${adminUserId}`
    : 'Admin credit adjustment';

  const results = await Promise.all([
    supabaseAdmin.from('wallets').update({ credits: newCredits }).eq('user_id', userId),
    supabaseAdmin.from('transactions').insert({
      user_id: userId,
      type: 'credit',
      amount: 0,
      credits: creditsToAdd,
      reference,
      status: 'success',
      description,
      created_at: new Date().toISOString(),
    }),
  ]);

  const failedResult = results.find((result) => result?.error);
  if (failedResult?.error) {
    throw failedResult.error;
  }

  return {
    userId,
    creditsAdded: creditsToAdd,
    newCredits,
    reference,
  };
}

export async function deleteUserAccount(supabaseAdmin, payload) {
  const userId = String(payload.userId || '').trim();
  if (!userId) {
    throw new Error('userId is required');
  }

  const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteAuthError) {
    throw deleteAuthError;
  }

  await Promise.all([
    supabaseAdmin.from('admin_users').delete().eq('user_id', userId),
    supabaseAdmin.from('subscriptions').delete().eq('user_id', userId),
    supabaseAdmin.from('sessions').delete().eq('user_id', userId),
    supabaseAdmin.from('transactions').delete().eq('user_id', userId),
    supabaseAdmin.from('wallets').delete().eq('user_id', userId),
    supabaseAdmin.from('users').delete().eq('id', userId),
  ]);

  return { userId, deleted: true };
}

export { listCreditPackages, updateCreditPackages };