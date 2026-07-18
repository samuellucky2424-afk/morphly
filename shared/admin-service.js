import { listCreditPackages as listCreditPackageRecords, updateCreditPackages } from './credit-packages.js';

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

const REPORTING_PAGE_SIZE = 1000;
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['success', 'successful', 'succeeded', 'completed', 'paid', 'verified']);
const PURCHASE_TRANSACTION_TYPES = new Set(['credit', 'credit_purchase', 'purchase', 'payment']);

function normalizeReportOptions(options = {}) {
  const requestedDays = Number.parseInt(String(options.days ?? 30), 10);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const normalizeDimension = (value) => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return !normalized || normalized === 'all' ? null : normalized.slice(0, 60);
  };
  return {
    days,
    since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
    platform: normalizeDimension(options.platform),
    source: normalizeDimension(options.source),
  };
}

async function fetchAllRows(buildQuery, sourceName) {
  const rows = [];
  for (let from = 0; ; from += REPORTING_PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + REPORTING_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Unable to read ${sourceName}: ${error.message || error.code || 'Supabase query failed'}`);
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < REPORTING_PAGE_SIZE) break;
  }
  return rows;
}

async function fetchOptionalRows(buildQuery, sourceName) {
  try {
    return { rows: await fetchAllRows(buildQuery, sourceName), available: true };
  } catch (error) {
    if (/42P01|PGRST205|does not exist|schema cache/i.test(String(error?.message || error))) {
      return { rows: [], available: false };
    }
    throw error;
  }
}

function isSuccessfulPayment(transaction) {
  const status = String(transaction?.status ?? '').trim().toLowerCase();
  return !status || SUCCESSFUL_PAYMENT_STATUSES.has(status);
}

function isPurchaseTransaction(transaction) {
  const reference = String(transaction?.reference ?? '').trim().toLowerCase();
  if (reference === 'manual-admin-credit' || reference.startsWith('admin:')) return false;
  const type = String(transaction?.type ?? '').trim().toLowerCase();
  if (PURCHASE_TRANSACTION_TYPES.has(type)) return true;
  if (['debit', 'usage', 'session_usage'].includes(type)) return false;
  if (transaction?.package_id || transaction?.package_name_snapshot) return true;
  const description = String(transaction?.description ?? '').toLowerCase();
  return normalizeAmount(transaction?.amount_naira ?? transaction?.amount) > 0
    && /(purchase|payment|top.?up|credits?)/.test(description);
}

function transactionAmount(transaction) {
  return normalizeAmount(transaction?.amount_naira ?? transaction?.package_price_snapshot_ngn ?? transaction?.amount);
}

function transactionDate(transaction) {
  return transaction?.verified_at || transaction?.created_at || null;
}

function queryAnalyticsEvents(supabaseAdmin, filters, columns = '*') {
  return () => {
    let query = supabaseAdmin.from('analytics_events').select(columns)
      .gte('created_at', filters.since).order('created_at', { ascending: true });
    if (filters.platform) query = query.eq('platform', filters.platform);
    if (filters.source) query = query.eq('acquisition_source', filters.source);
    return query;
  };
}

function isMorphlyAuthUser(user) {
  return String(user?.user_metadata?.app || '').trim().toLowerCase() === 'morphly';
}

function buildMorphlyUserIdSet(authUsers, sessions = [], transactions = []) {
  const ids = new Set(authUsers.filter(isMorphlyAuthUser).map((user) => user.id));
  for (const session of sessions) if (session.user_id) ids.add(session.user_id);
  for (const transaction of transactions) {
    const reference = String(transaction?.reference || '').toLowerCase();
    if (transaction.user_id && (ids.has(transaction.user_id) || transaction.package_id || reference.startsWith('morphly_'))) {
      ids.add(transaction.user_id);
    }
  }
  return ids;
}

function buildGrowthSeries(days, signups, events, sessions, purchases) {
  const points = new Map();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    points.set(key, { date: key, signups: 0, activated: 0, buyers: 0 });
  }

  for (const user of signups) {
    const day = String(user.created_at || '').slice(0, 10);
    if (points.has(day)) points.get(day).signups += 1;
  }

  const activations = new Map();
  const firstFrameEvents = events.filter((event) => event.event_name === 'first_frame_received');
  const activationRecords = firstFrameEvents.length
    ? firstFrameEvents.map((event) => ({
        identity: event.user_id || event.installation_id,
        created_at: event.created_at,
      }))
    : sessions.map((session) => ({ identity: session.user_id, created_at: session.created_at || session.start_time }));
  for (const record of activationRecords) {
    if (!record.identity) continue;
    const day = String(record.created_at || '').slice(0, 10);
    if (!points.has(day)) continue;
    if (!activations.has(day)) activations.set(day, new Set());
    activations.get(day).add(record.identity);
  }
  for (const [day, identities] of activations) points.get(day).activated = identities.size;

  const buyers = new Map();
  for (const transaction of purchases) {
    const day = String(transactionDate(transaction) || '').slice(0, 10);
    if (!points.has(day) || !transaction.user_id) continue;
    if (!buyers.has(day)) buyers.set(day, new Set());
    buyers.get(day).add(transaction.user_id);
  }
  for (const [day, identities] of buyers) points.get(day).buyers = identities.size;

  return [...points.values()];
}

export async function getAdminOverview(supabaseAdmin, options = {}) {
  const filters = normalizeReportOptions(options);
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

  const [wallets, sessions, transactions, profiles, analyticsResult] = await Promise.all([
    fetchAllRows(
      () => supabaseAdmin.from('wallets').select('user_id, credits').order('user_id'),
      'wallets',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('sessions').select('*').gte('created_at', filters.since).order('created_at', { ascending: true }),
      'sessions',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('transactions').select('*').gte('created_at', filters.since).order('created_at', { ascending: true }),
      'transactions',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('users').select('*').order('created_at', { ascending: true }),
      'users',
    ),
    fetchOptionalRows(
      queryAnalyticsEvents(supabaseAdmin, filters, 'event_name, user_id, installation_id, platform, acquisition_source, created_at'),
      'analytics_events',
    ),
  ]);

  const morphlyUserIds = buildMorphlyUserIdSet(authUsers, sessions, transactions);
  const morphlyAuthUsers = authUsers.filter((user) => morphlyUserIds.has(user.id));
  const events = analyticsResult.rows.filter((event) => !event.user_id || morphlyUserIds.has(event.user_id));
  const cohortUserIds = (filters.platform || filters.source)
    ? new Set(events.map((event) => event.user_id).filter(Boolean))
    : morphlyUserIds;
  const filteredTransactions = transactions.filter((transaction) =>
    morphlyUserIds.has(transaction.user_id) && cohortUserIds.has(transaction.user_id));
  const filteredSessions = sessions.filter((session) =>
    morphlyUserIds.has(session.user_id) && cohortUserIds.has(session.user_id));

  const totalCredits = wallets.filter((wallet) => morphlyUserIds.has(wallet.user_id)).reduce(
    (sum, wallet) => sum + normalizeCredits(wallet.credits),
    0,
  );

  const successfulPurchases = filteredTransactions.filter((transaction) =>
    isPurchaseTransaction(transaction) && isSuccessfulPayment(transaction));
  const revenueNGN = successfulPurchases.reduce(
    (sum, transaction) => sum + transactionAmount(transaction),
    0,
  );
  const purchaseCounts = new Map();
  for (const transaction of successfulPurchases) purchaseCounts.set(transaction.user_id, (purchaseCounts.get(transaction.user_id) || 0) + 1);
  const eventIdentities = (eventName) => new Set(events.filter((event) => event.event_name === eventName).map((event) => event.user_id || event.installation_id).filter(Boolean));
  const downloads = eventIdentities('download_clicked').size;
  const activatedUsers = eventIdentities('first_frame_received').size
    || new Set(filteredSessions.map((session) => session.user_id).filter(Boolean)).size;
  const gatewayFeesNGN = successfulPurchases.reduce((sum, transaction) => sum + normalizeAmount(transaction.gateway_fee_ngn), 0);
  const refundsNGN = successfulPurchases.filter((transaction) => transaction.refund_status && transaction.refund_status !== 'none')
    .reduce((sum, transaction) => sum + transactionAmount(transaction), 0);
  const failedSessions = filteredSessions.filter((session) =>
    ['failed', 'error', 'interrupted'].includes(String(session.status || '').toLowerCase())).length;
  const signups = morphlyAuthUsers.filter((user) =>
    String(user.created_at || '') >= filters.since && cohortUserIds.has(user.id));
  const growthByDay = buildGrowthSeries(filters.days, signups, events, filteredSessions, successfulPurchases);

  return {
    totalUsers: morphlyAuthUsers.length,
    blockedUsers: profiles.filter((profile) => morphlyUserIds.has(profile.id) && profile.account_status === 'suspended').length,
    totalCredits,
    revenueNGN,
    activeSessions: filteredSessions.filter((session) => session.status === 'active').length,
    downloads,
    signups: signups.length,
    activatedUsers,
    buyers: purchaseCounts.size,
    repeatBuyers: [...purchaseCounts.values()].filter((count) => count > 1).length,
    sessions: filteredSessions.length,
    failedSessions,
    gatewayFeesNGN,
    refundsNGN,
    growthSeries: growthByDay,
    periodDays: filters.days,
    asOf: new Date().toISOString(),
    dataHealth: {
      analyticsAvailable: analyticsResult.available,
      analyticsEvents: events.length,
      transactionsRead: filteredTransactions.length,
      sessionsRead: filteredSessions.length,
    },
  };
}

export async function listAdminUsers(supabaseAdmin, options = {}) {
  const filters = normalizeReportOptions(options);
  const authUsers = await listAllAuthUsers(supabaseAdmin);
  const userIds = authUsers.map((user) => user.id);

  if (userIds.length === 0) {
    return [];
  }

  const [wallets, admins, profiles, transactions, sessions, analyticsResult] = await Promise.all([
    fetchAllRows(() => supabaseAdmin.from('wallets').select('user_id, credits').order('user_id'), 'wallets'),
    fetchAllRows(() => supabaseAdmin.from('admin_users').select('user_id, role').eq('is_active', true).order('user_id'), 'admin_users'),
    fetchAllRows(() => supabaseAdmin.from('users').select('*').order('created_at', { ascending: false }), 'users'),
    fetchAllRows(
      () => supabaseAdmin.from('transactions').select('*').gte('created_at', filters.since).order('created_at', { ascending: false }),
      'transactions',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('sessions').select('*').gte('created_at', filters.since).order('created_at', { ascending: false }),
      'sessions',
    ),
    fetchOptionalRows(queryAnalyticsEvents(supabaseAdmin, filters), 'analytics_events'),
  ]);

  const walletByUserId = new Map(wallets.map((wallet) => [wallet.user_id, normalizeCredits(wallet.credits)]));
  const adminByUserId = new Map(admins.map((admin) => [admin.user_id, admin.role]));
  const statusByUserId = new Map(profiles.map((profile) => [profile.id, profile.account_status || 'active']));
  const purchaseByUserId = new Map();
  const latestPurchaseByUserId = new Map();
  for (const transaction of transactions) {
    if (!isPurchaseTransaction(transaction) || !isSuccessfulPayment(transaction)) continue;
    const current = purchaseByUserId.get(transaction.user_id) || { purchases: 0, spent: 0 };
    current.purchases += 1; current.spent += transactionAmount(transaction);
    purchaseByUserId.set(transaction.user_id, current);
    if (!latestPurchaseByUserId.has(transaction.user_id)) latestPurchaseByUserId.set(transaction.user_id, transaction);
  }

  const sessionByUserId = new Map();
  for (const session of sessions) {
    const current = sessionByUserId.get(session.user_id) || { total: 0, successful: 0 };
    current.total += 1;
    if (!['failed', 'error', 'interrupted'].includes(String(session.status || '').toLowerCase())) current.successful += 1;
    sessionByUserId.set(session.user_id, current);
  }

  const latestEventByUserId = new Map();
  for (const event of analyticsResult.rows) {
    if (event.user_id) latestEventByUserId.set(event.user_id, event);
  }
  const morphlyUserIds = buildMorphlyUserIdSet(authUsers, sessions, transactions);
  const dimensionUserIds = (filters.platform || filters.source)
    ? new Set(analyticsResult.rows.map((event) => event.user_id).filter(Boolean))
    : null;

  return authUsers
    .filter((authUser) => morphlyUserIds.has(authUser.id))
    .filter((authUser) => String(authUser.created_at || '') >= filters.since)
    .filter((authUser) => !dimensionUserIds || dimensionUserIds.has(authUser.id))
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
      plan: latestPurchaseByUserId.get(authUser.id)?.package_name_snapshot || 'Credits',
      platform: latestEventByUserId.get(authUser.id)?.platform || 'unknown',
      source: latestEventByUserId.get(authUser.id)?.acquisition_source || 'unknown',
      sessions: sessionByUserId.get(authUser.id)?.total || 0,
      successRate: sessionByUserId.has(authUser.id)
        ? Math.round((sessionByUserId.get(authUser.id).successful / sessionByUserId.get(authUser.id).total) * 100)
        : 0,
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

export async function listAdminTransactions(supabaseAdmin, options = {}) {
  const filters = normalizeReportOptions(options);
  const [data, analyticsResult, sessions] = await Promise.all([
    fetchAllRows(
      () => supabaseAdmin.from('transactions').select('*')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'transactions',
    ),
    (filters.platform || filters.source)
      ? fetchOptionalRows(queryAnalyticsEvents(supabaseAdmin, filters), 'analytics_events')
      : Promise.resolve({ rows: [], available: true }),
    fetchAllRows(
      () => supabaseAdmin.from('sessions').select('user_id, created_at')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'sessions',
    ),
  ]);
  const users = await listAllAuthUsers(supabaseAdmin);
  const emailById = new Map(users.map((user) => [user.id, user.email || user.id]));
  const morphlyUserIds = buildMorphlyUserIdSet(users, sessions, data);
  const latestEventByUserId = new Map();
  for (const event of analyticsResult.rows) {
    if (event.user_id) latestEventByUserId.set(event.user_id, event);
  }
  const cohortUserIds = (filters.platform || filters.source)
    ? new Set(analyticsResult.rows.map((event) => event.user_id).filter(Boolean))
    : null;
  return data
    .filter(isPurchaseTransaction)
    .filter((tx) => morphlyUserIds.has(tx.user_id))
    .filter((tx) => !cohortUserIds || cohortUserIds.has(tx.user_id))
    .map((tx) => ({
    ref: tx.reference || tx.id, userId: tx.user_id, customer: emailById.get(tx.user_id) || tx.user_id,
    type: tx.type || null, packageId: tx.package_id || null,
    package: tx.package_name_snapshot || tx.description || 'Credit purchase', amount: Number(tx.amount_naira || tx.amount || 0),
    credits: Number(tx.package_credits_snapshot || tx.credits || 0), gateway: tx.payment_gateway || 'manual',
    status: isSuccessfulPayment(tx) ? 'success' : (tx.status || 'pending'),
    rawStatus: tx.status || null, date: transactionDate(tx), gatewayFee: Number(tx.gateway_fee_ngn || 0),
    refundStatus: tx.refund_status || 'none',
    platform: latestEventByUserId.get(tx.user_id)?.platform || 'unknown',
    source: latestEventByUserId.get(tx.user_id)?.acquisition_source || 'unknown',
  }))
    .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
}

export async function listSystemLogs(supabaseAdmin, options = {}) {
  const filters = normalizeReportOptions(options);
  const [errorResult, sessions, transactions] = await Promise.all([
    fetchOptionalRows(() => {
      let query = supabaseAdmin.from('error_logs').select('*')
        .gte('last_seen_at', filters.since).order('last_seen_at', { ascending: false });
      if (filters.platform) query = query.eq('platform', filters.platform);
      return query;
    }, 'error_logs'),
    fetchAllRows(
      () => supabaseAdmin.from('sessions').select('*')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'sessions',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('transactions').select('*')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'transactions',
    ),
  ]);

  if (errorResult.rows.length > 0) return errorResult.rows;

  const latestSession = sessions[0]?.created_at || sessions[0]?.start_time || new Date().toISOString();
  const latestTransaction = transactions[0] ? transactionDate(transactions[0]) : new Date().toISOString();
  const failures = sessions.filter((session) =>
    ['failed', 'error', 'interrupted'].includes(String(session.status || '').toLowerCase()));
  const successfulPayments = transactions.filter((transaction) =>
    isPurchaseTransaction(transaction) && isSuccessfulPayment(transaction));
  const operationalLogs = [];

  if (sessions.length > 0) {
    operationalLogs.push({
      fingerprint: 'derived-session-activity',
      error_code: 'SESSION_ACTIVITY',
      safe_message: 'Real Morphly sessions recorded in the selected period',
      user_id: null,
      platform: filters.platform || 'all',
      severity: 'info',
      occurrences: sessions.length,
      first_seen_at: sessions.at(-1)?.created_at || sessions.at(-1)?.start_time || latestSession,
      last_seen_at: latestSession,
      metadata: { derivedFrom: 'sessions', active: sessions.filter((session) => session.status === 'active').length },
    });
  }
  if (successfulPayments.length > 0) {
    operationalLogs.push({
      fingerprint: 'derived-payment-activity',
      error_code: 'PAYMENT_ACTIVITY',
      safe_message: 'Verified customer payments recorded in the selected period',
      user_id: null,
      platform: 'all',
      severity: 'info',
      occurrences: successfulPayments.length,
      first_seen_at: transactionDate(successfulPayments.at(-1)) || latestTransaction,
      last_seen_at: transactionDate(successfulPayments[0]) || latestTransaction,
      metadata: { derivedFrom: 'transactions' },
    });
  }
  if (failures.length > 0) {
    operationalLogs.push({
      fingerprint: 'derived-session-failures',
      error_code: 'SESSION_FAILURE',
      safe_message: 'Sessions ended with a failure or interruption status',
      user_id: null,
      platform: filters.platform || 'all',
      severity: 'warning',
      occurrences: failures.length,
      first_seen_at: failures.at(-1)?.created_at || latestSession,
      last_seen_at: failures[0]?.created_at || latestSession,
      metadata: { derivedFrom: 'sessions' },
    });
  }

  return operationalLogs.sort((left, right) =>
    String(right.last_seen_at || '').localeCompare(String(left.last_seen_at || '')));
}

export async function listCreditPackages(supabaseAdmin, options = {}) {
  const packages = await listCreditPackageRecords(supabaseAdmin, options);
  if (packages.length === 0) return packages;
  const { data, error } = await supabaseAdmin.from('transactions')
    .select('*')
    .in('package_id', packages.map((pkg) => pkg.id));
  if (error && !['PGRST204', '42703'].includes(error.code)) throw error;
  const stats = new Map();
  for (const transaction of data || []) {
    if (!isSuccessfulPayment(transaction) || !isPurchaseTransaction(transaction)) continue;
    const item = stats.get(transaction.package_id) || { purchases: 0, revenueNGN: 0 };
    item.purchases += 1;
    item.revenueNGN += transactionAmount(transaction);
    stats.set(transaction.package_id, item);
  }
  return packages.map((pkg) => ({ ...pkg, purchases: stats.get(pkg.id)?.purchases || 0, revenueNGN: stats.get(pkg.id)?.revenueNGN || 0 }));
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

export { updateCreditPackages };
