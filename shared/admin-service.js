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

  const results = await Promise.allSettled([
    supabaseAdmin.from('wallets').select('credits').in('user_id', userIds),
    supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabaseAdmin.from('transactions').select('*').in('user_id', userIds),
    supabaseAdmin.from('users').select('*').in('id', userIds),
  ]);
  const result = (index) => results[index].status === 'fulfilled' && !results[index].value.error ? results[index].value : { data: [], count: 0 };
  const walletsResult = result(0), activeSessionsResult = result(1), transactionsResult = result(2), profilesResult = result(3);

  const totalCredits = (walletsResult.data || []).reduce(
    (sum, wallet) => sum + normalizeCredits(wallet.credits),
    0,
  );

  const revenueNGN = (transactionsResult.data || []).reduce((sum, transaction) => {
    if (!['credit', 'credit_purchase'].includes(transaction.type) || !['success', 'successful', undefined, null].includes(transaction.status)) {
      return sum;
    }

    return sum + normalizeAmount(transaction.amount_naira ?? transaction.amount);
  }, 0);

  return {
    totalUsers: authUsers.length,
    blockedUsers: (profilesResult.data || []).filter((profile) => profile.account_status === 'suspended').length,
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

  const queryResults = await Promise.allSettled([
    supabaseAdmin.from('wallets').select('user_id, credits').in('user_id', userIds),
    supabaseAdmin.from('admin_users').select('user_id, role').eq('is_active', true).in('user_id', userIds),
    supabaseAdmin.from('users').select('*').in('id', userIds),
    supabaseAdmin.from('transactions').select('*').in('user_id', userIds),
  ]);
  const result = (index) => queryResults[index].status === 'fulfilled' && !queryResults[index].value.error ? queryResults[index].value : { data: [] };
  const walletsResult = result(0), adminsResult = result(1), profilesResult = result(2), transactionsResult = result(3);

  const walletByUserId = new Map((walletsResult.data || []).map((wallet) => [wallet.user_id, normalizeCredits(wallet.credits)]));
  const adminByUserId = new Map((adminsResult.data || []).map((admin) => [admin.user_id, admin.role]));
  const statusByUserId = new Map((profilesResult.data || []).map((profile) => [profile.id, profile.account_status || 'active']));
  const purchaseByUserId = new Map();
  for (const transaction of transactionsResult.data || []) {
    if (transaction.status && !['success', 'successful'].includes(transaction.status)) continue;
    const current = purchaseByUserId.get(transaction.user_id) || { purchases: 0, spent: 0 };
    current.purchases += 1; current.spent += normalizeAmount(transaction.amount_naira ?? transaction.amount);
    purchaseByUserId.set(transaction.user_id, current);
  }

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
      status: statusByUserId.get(authUser.id) || 'active',
      purchases: purchaseByUserId.get(authUser.id)?.purchases || 0,
      spent: purchaseByUserId.get(authUser.id)?.spent || 0,
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

  const reason = String(payload.reason || '').trim();
  if (reason.length < 3) throw new Error('A reason is required');
  const idempotencyKey = String(payload.idempotencyKey || `admin:${adminUserId}:${userId}:${Date.now()}`);
  const { data, error } = await supabaseAdmin.rpc('admin_adjust_credits', {
    p_admin: adminUserId, p_user: userId, p_amount: creditsToAdd, p_reason: reason, p_key: idempotencyKey,
  });
  if (error) throw error;
  return data;
}

export async function setUserStatus(supabaseAdmin, payload) {
  const userId = String(payload.userId || '').trim();
  const status = String(payload.status || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!userId || !['active', 'suspended'].includes(status) || reason.length < 3) throw new Error('Valid user, status and reason are required');
  const { data, error } = await supabaseAdmin.rpc('admin_set_user_status', {
    p_admin: payload.adminUserId, p_user: userId, p_status: status, p_reason: reason,
  });
  if (error) throw error;
  return data;
}

export async function listAdminTransactions(supabaseAdmin) {
  const { data, error } = await supabaseAdmin.from('transactions').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const users = await listAllAuthUsers(supabaseAdmin);
  const emailById = new Map(users.map((user) => [user.id, user.email || user.id]));
  return (data || []).map((tx) => ({
    ref: tx.reference || tx.id, userId: tx.user_id, customer: emailById.get(tx.user_id) || tx.user_id,
    package: tx.package_name_snapshot || tx.description || 'Credit purchase', amount: Number(tx.amount_naira || tx.amount || 0),
    credits: Number(tx.package_credits_snapshot || tx.credits || 0), gateway: tx.payment_gateway || 'manual',
    status: tx.status || 'success', date: tx.verified_at || tx.created_at, gatewayFee: Number(tx.gateway_fee_ngn || 0),
    refundStatus: tx.refund_status || 'none',
  }));
}

export async function listSystemLogs(supabaseAdmin) {
  const { data, error } = await supabaseAdmin.from('error_logs').select('*').order('last_seen_at', { ascending: false }).limit(500);
  if (error && ['42P01', 'PGRST205'].includes(error.code)) return [];
  if (error) throw error;
  return data || [];
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
