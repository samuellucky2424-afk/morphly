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
const SYSTEM_LOG_SOURCE_LIMIT = 5000;
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

async function fetchAllRows(buildQuery, sourceName, maxRows = Number.POSITIVE_INFINITY) {
  const rows = [];
  const boundedMaxRows = Number.isFinite(maxRows)
    ? Math.max(0, Math.floor(maxRows))
    : Number.POSITIVE_INFINITY;
  for (let from = 0; from < boundedMaxRows; from += REPORTING_PAGE_SIZE) {
    const to = Number.isFinite(boundedMaxRows)
      ? Math.min(from + REPORTING_PAGE_SIZE - 1, boundedMaxRows - 1)
      : from + REPORTING_PAGE_SIZE - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) {
      throw new Error(`Unable to read ${sourceName}: ${error.message || error.code || 'Supabase query failed'}`);
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < to - from + 1 || rows.length >= boundedMaxRows) break;
  }
  return rows;
}

async function fetchOptionalRows(buildQuery, sourceName, maxRows = Number.POSITIVE_INFINITY) {
  try {
    const fetchLimit = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) + 1 : maxRows;
    const rows = await fetchAllRows(buildQuery, sourceName, fetchLimit);
    return {
      rows: Number.isFinite(maxRows) ? rows.slice(0, maxRows) : rows,
      available: true,
      truncated: Number.isFinite(maxRows) && rows.length > maxRows,
    };
  } catch (error) {
    if (/42P01|PGRST205|does not exist|schema cache/i.test(String(error?.message || error))) {
      return { rows: [], available: false, truncated: false };
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

function normalizeUuid(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function normalizeHistoryLimit(value) {
  const parsed = Number.parseInt(String(value ?? 100), 10);
  return Number.isFinite(parsed) ? Math.max(20, Math.min(200, parsed)) : 100;
}

function normalizeEventText(value, fallback = '') {
  const normalized = String(value || fallback).replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 240);
}

function humanizeEventName(value) {
  return String(value || 'system.event')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function systemEventSeverity(eventName, fallback = 'info') {
  const normalized = String(eventName || '').toLowerCase();
  const normalizedFallback = String(fallback || 'info').toLowerCase();
  if (['fatal', 'critical', 'error'].includes(normalizedFallback)) return 'critical';
  if (['warn', 'warning'].includes(normalizedFallback)) return 'warning';
  if (/(fatal|critical|crash|exception)/.test(normalized)) return 'critical';
  if (/(fail|error|invalid|reject|disconnect|suspend|deduct|refund)/.test(normalized)) return 'warning';
  return fallback;
}

function addGroupedSystemLog(logsByKey, input) {
  const event = String(input.event || 'SYSTEM_EVENT').trim().toUpperCase();
  const userId = input.userId || null;
  const platform = String(input.platform || 'all').trim().toLowerCase() || 'all';
  const source = String(input.source || 'all').trim().toLowerCase() || 'all';
  const severity = systemEventSeverity(event, input.severity || 'info');
  const message = normalizeEventText(input.message, humanizeEventName(event));
  const firstSeenAt = input.firstSeenAt || input.lastSeenAt || new Date().toISOString();
  const lastSeenAt = input.lastSeenAt || input.firstSeenAt || firstSeenAt;
  const occurrences = Math.max(1, Number(input.occurrences || 1));
  const recordSource = String(input.recordSource || 'system').trim().toLowerCase() || 'system';
  const key = input.key || [event, userId || 'system', platform, source, recordSource, severity, message].join('|');
  const existing = logsByKey.get(key);

  if (existing) {
    existing.occurrences += occurrences;
    if (String(firstSeenAt) < String(existing.first_seen_at)) existing.first_seen_at = firstSeenAt;
    if (String(lastSeenAt) > String(existing.last_seen_at)) existing.last_seen_at = lastSeenAt;
    return;
  }

  logsByKey.set(key, {
    fingerprint: key,
    event,
    error_code: event,
    safe_message: message,
    user_id: userId,
    user: input.user || null,
    platform,
    source,
    record_source: recordSource,
    severity,
    occurrences,
    first_seen_at: firstSeenAt,
    last_seen_at: lastSeenAt,
  });
}

function queryAnalyticsEvents(supabaseAdmin, filters, columns = '*', ascending = true) {
  return () => {
    let query = supabaseAdmin.from('analytics_events').select(columns)
      .gte('created_at', filters.since).order('created_at', { ascending });
    if (filters.platform) query = query.eq('platform', filters.platform);
    if (filters.source) query = query.eq('acquisition_source', filters.source);
    return query;
  };
}

function isMorphlyAuthUser(user, profileIds) {
  if (String(user?.user_metadata?.app || '').trim().toLowerCase() === 'morphly') return true;
  // Users who exist in public.users are Morphly-owned even without the metadata tag
  // (covers accounts created before the tag was introduced).
  if (profileIds && profileIds.has(user?.id)) return true;
  return false;
}

function buildMorphlyUserIdSet(authUsers, sources = {}) {
  const profiles = sources.profiles || [];
  const wallets = sources.wallets || [];
  const sessions = sources.sessions || [];
  const transactions = sources.transactions || [];
  // Build a set of all profile IDs so isMorphlyAuthUser can check membership.
  const profileIds = new Set(profiles.map((p) => p.id).filter(Boolean));
  const ids = new Set(authUsers.filter((u) => isMorphlyAuthUser(u, profileIds)).map((user) => user.id));
  // Ensure every profile-backed user is always included.
  for (const profile of profiles) if (profile.id) ids.add(profile.id);
  for (const wallet of wallets) if (wallet.user_id) ids.add(wallet.user_id);
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
  if (authUsers.length === 0) {
    return {
      totalUsers: 0,
      blockedUsers: 0,
      totalCredits: 0,
      revenueNGN: 0,
      activeSessions: 0,
    };
  }

  const [wallets, sessions, transactions, profiles, analyticsResult, errorResult] = await Promise.all([
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
    fetchOptionalRows(() => {
      let query = supabaseAdmin.from('error_logs').select('occurrences, severity, platform, user_id, last_seen_at').gte('last_seen_at', filters.since);
      if (filters.platform) query = query.eq('platform', filters.platform);
      return query;
    }, 'error_logs'),
  ]);

  const morphlyUserIds = buildMorphlyUserIdSet(authUsers, { profiles, wallets, sessions, transactions });
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

  const filteredErrors = errorResult.rows.filter((log) => 
    (!log.user_id || morphlyUserIds.has(log.user_id)) && 
    (!cohortUserIds || !log.user_id || cohortUserIds.has(log.user_id))
  );

  const crashes = filteredErrors
    .filter((log) => log.severity === 'critical')
    .reduce((sum, log) => sum + (Number(log.occurrences) || 1), 0);
  
  const apiErrors = filteredErrors
    .filter((log) => log.severity === 'error')
    .reduce((sum, log) => sum + (Number(log.occurrences) || 1), 0);
  
  const apiRequests = events.length;

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
    crashes,
    apiRequests,
    apiErrors,
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
  if (authUsers.length === 0) {
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
  const morphlyUserIds = buildMorphlyUserIdSet(authUsers, { profiles, wallets, sessions, transactions });
  const dimensionUserIds = (filters.platform || filters.source)
    ? new Set(analyticsResult.rows.map((event) => event.user_id).filter(Boolean))
    : null;

  return authUsers
    .filter((authUser) => morphlyUserIds.has(authUser.id))
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

function normalizeSessionSeconds(value) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

function sessionTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getSessionDurationSeconds(session, nowMs) {
  const startedAt = sessionTimestamp(session.start_time || session.created_at);
  const endedAt = sessionTimestamp(session.end_time) ?? (
    String(session.status || '').toLowerCase() === 'active' ? nowMs : startedAt
  );
  if (startedAt === null || endedAt === null || endedAt <= startedAt) return 0;
  return Math.floor((endedAt - startedAt) / 1000);
}

/**
 * Admin-only Decart usage report.
 *
 * "Untracked exposure" is intentionally not presented as confirmed billing. It
 * is the portion of a session that had a first-frame event but was not covered
 * by recorded generation ticks, capped by the provider session limit. This
 * makes client heartbeat failures and possible token replay visible without
 * claiming that every wall-clock second was billed by Decart.
 */
export async function listAdminUsage(supabaseAdmin, options = {}) {
  const filters = normalizeReportOptions(options);
  const nowMs = Date.now();
  const authUsersPromise = listAllAuthUsers(supabaseAdmin);
  const [authUsers, sessions, wallets, transactions, ledgerResult, admins, analyticsResult] = await Promise.all([
    authUsersPromise,
    fetchAllRows(
      () => supabaseAdmin.from('sessions').select('*')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'sessions',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('wallets').select('user_id, credits, updated_at').order('user_id'),
      'wallets',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('transactions').select('*').order('created_at', { ascending: false }),
      'transactions',
    ),
    fetchOptionalRows(
      () => supabaseAdmin.from('wallet_ledger')
        .select('user_id, delta, entry_type, created_at').order('created_at', { ascending: false }),
      'wallet_ledger',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('admin_users').select('user_id').eq('is_active', true).order('user_id'),
      'admin_users',
    ),
    fetchOptionalRows(
      () => supabaseAdmin.from('analytics_events')
        .select('user_id, session_id, installation_id, event_name, metadata, created_at')
        .gte('created_at', filters.since)
        .in('event_name', ['first_frame_received', 'decart_token_issued'])
        .order('created_at', { ascending: false }),
      'analytics_events',
    ),
  ]);

  const emailByUserId = new Map(authUsers.map((user) => [user.id, user.email || user.id]));
  const walletByUserId = new Map(wallets.map((wallet) => [wallet.user_id, wallet]));
  const adminUserIds = new Set(admins.map((admin) => admin.user_id));
  const transactionGrantsByUserId = new Map();
  const ledgerGrantsByUserId = new Map();

  for (const transaction of transactions) {
    const type = String(transaction.transaction_type || transaction.type || '').toLowerCase();
    if (['debit', 'usage', 'session_usage'].includes(type)) continue;
    const credits = Math.max(
      normalizeSessionSeconds(transaction.credits),
      normalizeSessionSeconds(transaction.package_credits_snapshot),
    );
    if (transaction.user_id && credits > 0) {
      transactionGrantsByUserId.set(
        transaction.user_id,
        (transactionGrantsByUserId.get(transaction.user_id) || 0) + credits,
      );
    }
  }
  for (const entry of ledgerResult.rows) {
    const delta = Number(entry.delta || 0);
    if (entry.user_id && Number.isFinite(delta) && delta > 0) {
      ledgerGrantsByUserId.set(
        entry.user_id,
        (ledgerGrantsByUserId.get(entry.user_id) || 0) + Math.floor(delta),
      );
    }
  }
  const firstFrameSessionIds = new Set(
    analyticsResult.rows
      .filter((event) => event.event_name === 'first_frame_received' && event.session_id)
      .map((event) => event.session_id),
  );
  const tokenEventsByUserId = new Map();
  const installationsByUserId = new Map();
  const installationBySessionId = new Map();

  for (const event of analyticsResult.rows) {
    if (event.user_id && event.installation_id) {
      if (!installationsByUserId.has(event.user_id)) installationsByUserId.set(event.user_id, new Set());
      installationsByUserId.get(event.user_id).add(event.installation_id);
    }
    if (event.session_id && event.installation_id && !installationBySessionId.has(event.session_id)) {
      installationBySessionId.set(event.session_id, event.installation_id);
    }
    if (event.event_name === 'decart_token_issued' && event.user_id) {
      tokenEventsByUserId.set(event.user_id, (tokenEventsByUserId.get(event.user_id) || 0) + 1);
    }
  }

  const usageByUserId = new Map();
  const sessionRows = sessions.map((session) => {
    const recordedSeconds = normalizeSessionSeconds(session.seconds_used);
    const recordedCredits = Math.max(
      normalizeSessionSeconds(session.cost),
      normalizeSessionSeconds(session.credits_used),
      recordedSeconds * 2,
    );
    const providerMaxSeconds = Math.max(
      10,
      normalizeSessionSeconds(session.provider_max_seconds) || 7200,
    );
    const wallSeconds = getSessionDurationSeconds(session, nowMs);
    const sawFirstFrame = firstFrameSessionIds.has(session.id);
    const untrackedExposureSeconds = sawFirstFrame
      ? Math.max(0, Math.min(wallSeconds, providerMaxSeconds) - recordedSeconds)
      : 0;
    const status = String(session.status || 'unknown').toLowerCase();
    const latestAt = session.end_time || session.start_time || session.created_at || null;
    const row = {
      id: session.id,
      userId: session.user_id,
      email: emailByUserId.get(session.user_id) || session.user_id,
      status,
      startedAt: session.start_time || session.created_at || null,
      endedAt: session.end_time || null,
      latestAt,
      recordedSeconds,
      recordedCredits,
      walletDebitedCredits: normalizeSessionSeconds(session.wallet_debited_credits),
      wallSeconds,
      untrackedExposureSeconds,
      untrackedExposureCredits: untrackedExposureSeconds * 2,
      providerMaxSeconds,
      providerModel: session.provider_model || 'lucy-2.5',
      installationId: session.client_installation_id || installationBySessionId.get(session.id) || null,
      sawFirstFrame,
    };

    const summary = usageByUserId.get(session.user_id) || {
      userId: session.user_id,
      email: emailByUserId.get(session.user_id) || session.user_id,
      walletCredits: normalizeCredits(walletByUserId.get(session.user_id)?.credits),
      sessions: 0,
      activeSessions: 0,
      recordedSeconds: 0,
      recordedCredits: 0,
      untrackedExposureSeconds: 0,
      untrackedExposureCredits: 0,
      firstActivityAt: null,
      lastActivityAt: null,
    };
    summary.sessions += 1;
    if (status === 'active') summary.activeSessions += 1;
    summary.recordedSeconds += recordedSeconds;
    summary.recordedCredits += recordedCredits;
    summary.untrackedExposureSeconds += untrackedExposureSeconds;
    summary.untrackedExposureCredits += untrackedExposureSeconds * 2;
    if (!summary.firstActivityAt || String(row.startedAt || '') < String(summary.firstActivityAt)) {
      summary.firstActivityAt = row.startedAt;
    }
    if (!summary.lastActivityAt || String(latestAt || '') > String(summary.lastActivityAt)) {
      summary.lastActivityAt = latestAt;
    }
    usageByUserId.set(session.user_id, summary);
    return row;
  });

  const users = [...usageByUserId.values()].map((summary) => {
    const installationIds = [...(installationsByUserId.get(summary.userId) || [])];
    const auditedTokenMints = tokenEventsByUserId.get(summary.userId) || 0;
    const tokenMints = Math.max(auditedTokenMints, summary.sessions);
    const explainedCreditGrants = Math.max(
      transactionGrantsByUserId.get(summary.userId) || 0,
      ledgerGrantsByUserId.get(summary.userId) || 0,
    );
    const unexplainedBalanceCredits = Math.max(0, summary.walletCredits - explainedCreditGrants);
    const isAdmin = adminUserIds.has(summary.userId);
    const reasons = [];
    if (summary.untrackedExposureSeconds >= 60) reasons.push('generation time missing from client usage reports');
    if (installationIds.length >= 3) reasons.push(`used from ${installationIds.length} installations`);
    if (tokenMints >= 10) reasons.push(`${tokenMints} provider tokens issued`);
    if (summary.activeSessions > 1) reasons.push(`${summary.activeSessions} active sessions`);
    if (!isAdmin && unexplainedBalanceCredits >= 5000) {
      reasons.push(`${unexplainedBalanceCredits.toLocaleString()} wallet credits lack a purchase or ledger grant`);
    }

    return {
      ...summary,
      isAdmin,
      tokenMints,
      auditedTokenMints,
      explainedCreditGrants,
      unexplainedBalanceCredits,
      installationIds,
      installationCount: installationIds.length,
      suspicious: reasons.length > 0,
      suspiciousReasons: reasons,
    };
  }).sort((left, right) =>
    right.recordedCredits - left.recordedCredits
    || right.untrackedExposureSeconds - left.untrackedExposureSeconds
    || right.sessions - left.sessions);

  return {
    periodDays: filters.days,
    since: filters.since,
    asOf: new Date(nowMs).toISOString(),
    totals: {
      users: users.length,
      sessions: sessionRows.length,
      activeSessions: sessionRows.filter((session) => session.status === 'active').length,
      recordedSeconds: users.reduce((sum, user) => sum + user.recordedSeconds, 0),
      recordedCredits: users.reduce((sum, user) => sum + user.recordedCredits, 0),
      untrackedExposureSeconds: users.reduce((sum, user) => sum + user.untrackedExposureSeconds, 0),
      untrackedExposureCredits: users.reduce((sum, user) => sum + user.untrackedExposureCredits, 0),
      usersWithUsageGaps: users.filter((user) => user.untrackedExposureSeconds > 0).length,
      auditedTokenMints: users.reduce((sum, user) => sum + user.auditedTokenMints, 0),
    },
    users,
    sessions: sessionRows.slice(0, 500),
    dataHealth: {
      analyticsAvailable: analyticsResult.available,
      walletLedgerAvailable: ledgerResult.available,
      tokenAuditEnabled: [...tokenEventsByUserId.values()].some((count) => count > 0),
    },
  };
}

export async function adjustUserCredits(supabaseAdmin, payload) {
  const userId = String(payload.userId || '').trim();
  const adjustment = Number(payload.adjustment);
  const adminUserId = String(payload.adminUserId || '').trim();

  if (!userId) {
    throw new Error('userId is required');
  }

  if (!Number.isSafeInteger(adjustment) || adjustment === 0 || Math.abs(adjustment) > 1_000_000) {
    throw new Error('adjustment must be a non-zero integer between -1000000 and 1000000');
  }

  const reason = String(payload.reason || '').trim();
  if (reason.length < 3 || reason.length > 240) {
    throw new Error('A reason between 3 and 240 characters is required');
  }
  const idempotencyKey = String(payload.idempotencyKey || `admin:${adminUserId}:${userId}:${Date.now()}`);
  if (idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 200) {
    throw new Error('A valid idempotency key is required');
  }
  const { data, error } = await supabaseAdmin.rpc('admin_adjust_credits', {
    p_admin: adminUserId, p_user: userId, p_amount: adjustment, p_reason: reason, p_key: idempotencyKey.trim(),
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
  const morphlyUserIds = buildMorphlyUserIdSet(users, { sessions, transactions: data });
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
  const [errorResult, analyticsResult, auditResult, sessionRows, transactionRows, authUsers] = await Promise.all([
    fetchOptionalRows(() => {
      let query = supabaseAdmin.from('error_logs').select('*')
        .gte('last_seen_at', filters.since).order('last_seen_at', { ascending: false });
      if (filters.platform) query = query.eq('platform', filters.platform);
      return query;
    }, 'error_logs', SYSTEM_LOG_SOURCE_LIMIT),
    fetchOptionalRows(queryAnalyticsEvents(
      supabaseAdmin,
      filters,
      'id, event_name, user_id, platform, acquisition_source, created_at',
      false,
    ), 'analytics_events', SYSTEM_LOG_SOURCE_LIMIT),
    fetchOptionalRows(
      () => supabaseAdmin.from('admin_audit_logs')
        .select('id, admin_user_id, action, target_type, target_id, reason, created_at')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'admin_audit_logs',
      SYSTEM_LOG_SOURCE_LIMIT,
    ),
    fetchAllRows(
      () => supabaseAdmin.from('sessions').select('*')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'sessions',
      SYSTEM_LOG_SOURCE_LIMIT + 1,
    ),
    fetchAllRows(
      () => supabaseAdmin.from('transactions').select('*')
        .gte('created_at', filters.since).order('created_at', { ascending: false }),
      'transactions',
      SYSTEM_LOG_SOURCE_LIMIT + 1,
    ),
    listAllAuthUsers(supabaseAdmin),
  ]);
  const sessionsTruncated = sessionRows.length > SYSTEM_LOG_SOURCE_LIMIT;
  const transactionsTruncated = transactionRows.length > SYSTEM_LOG_SOURCE_LIMIT;
  const sessions = sessionRows.slice(0, SYSTEM_LOG_SOURCE_LIMIT);
  const transactions = transactionRows.slice(0, SYSTEM_LOG_SOURCE_LIMIT);

  const emailById = new Map(authUsers.map((user) => [user.id, user.email || user.id]));
  const latestEventByUserId = new Map();
  for (const event of analyticsResult.rows) {
    if (event.user_id && !latestEventByUserId.has(event.user_id)) {
      latestEventByUserId.set(event.user_id, event);
    }
  }
  const cohortUserIds = (filters.platform || filters.source)
    ? new Set(analyticsResult.rows.map((event) => event.user_id).filter(Boolean))
    : null;
  const matchesCohort = (userId) => !cohortUserIds || (userId && cohortUserIds.has(userId));
  const matchesErrorFilters = (error) => {
    const userEvent = latestEventByUserId.get(error.user_id);
    if (filters.source && userEvent?.acquisition_source !== filters.source) return false;
    if (filters.platform) {
      const directPlatform = String(error.platform || '').trim().toLowerCase();
      if (directPlatform) return directPlatform === filters.platform;
      return userEvent?.platform === filters.platform;
    }
    return true;
  };
  const logsByKey = new Map();

  for (const error of errorResult.rows) {
    if (!matchesErrorFilters(error)) continue;
    const userEvent = latestEventByUserId.get(error.user_id);
    addGroupedSystemLog(logsByKey, {
      key: `error_logs:${error.fingerprint || error.id}`,
      event: error.error_code || 'APPLICATION_ERROR',
      message: error.safe_message || 'Application error recorded',
      userId: error.user_id,
      user: emailById.get(error.user_id) || error.user_id || null,
      platform: error.platform || userEvent?.platform || filters.platform || 'all',
      source: userEvent?.acquisition_source || filters.source || 'unknown',
      recordSource: 'error_logs',
      severity: error.severity || 'error',
      occurrences: error.occurrences,
      firstSeenAt: error.first_seen_at,
      lastSeenAt: error.last_seen_at,
    });
  }

  for (const event of analyticsResult.rows) {
    addGroupedSystemLog(logsByKey, {
      event: event.event_name || 'ANALYTICS_EVENT',
      message: `${humanizeEventName(event.event_name)} recorded`,
      userId: event.user_id,
      user: emailById.get(event.user_id) || event.user_id || null,
      platform: event.platform || 'unknown',
      source: event.acquisition_source || 'unknown',
      recordSource: 'analytics_events',
      severity: systemEventSeverity(event.event_name),
      firstSeenAt: event.created_at,
      lastSeenAt: event.created_at,
    });
  }

  for (const session of sessions) {
    if (!matchesCohort(session.user_id)) continue;
    const status = String(session.status || 'activity').trim().toLowerCase();
    const userEvent = latestEventByUserId.get(session.user_id);
    const timestamp = session.created_at || session.start_time || session.end_time;
    addGroupedSystemLog(logsByKey, {
      event: `SESSION_${status}`,
      message: `Morphly session ${status}`,
      userId: session.user_id,
      user: emailById.get(session.user_id) || session.user_id || null,
      platform: userEvent?.platform || filters.platform || 'unknown',
      source: userEvent?.acquisition_source || filters.source || 'unknown',
      recordSource: 'sessions',
      severity: systemEventSeverity(status),
      firstSeenAt: timestamp,
      lastSeenAt: session.end_time || timestamp,
    });
  }

  for (const transaction of transactions.filter(isPurchaseTransaction)) {
    if (!matchesCohort(transaction.user_id)) continue;
    const status = String(transaction.status || (isSuccessfulPayment(transaction) ? 'success' : 'pending'))
      .trim().toLowerCase();
    const userEvent = latestEventByUserId.get(transaction.user_id);
    const timestamp = transactionDate(transaction) || transaction.created_at;
    addGroupedSystemLog(logsByKey, {
      event: `PAYMENT_${status}`,
      message: `${transaction.payment_gateway || 'Payment'} transaction ${status}`,
      userId: transaction.user_id,
      user: emailById.get(transaction.user_id) || transaction.user_id || null,
      platform: userEvent?.platform || filters.platform || 'unknown',
      source: userEvent?.acquisition_source || filters.source || 'unknown',
      recordSource: 'transactions',
      severity: isSuccessfulPayment(transaction) ? 'info' : systemEventSeverity(status, 'warning'),
      firstSeenAt: transaction.created_at || timestamp,
      lastSeenAt: timestamp,
    });
  }

  for (const audit of auditResult.rows) {
    const targetUserId = audit.target_type === 'user' ? normalizeUuid(audit.target_id) : null;
    if (!matchesCohort(targetUserId)) continue;
    const userEvent = latestEventByUserId.get(targetUserId);
    addGroupedSystemLog(logsByKey, {
      event: audit.action || 'ADMIN_ACTION',
      message: normalizeEventText(audit.reason, humanizeEventName(audit.action)),
      userId: targetUserId,
      user: emailById.get(targetUserId) || targetUserId || null,
      platform: userEvent?.platform || 'web',
      source: userEvent?.acquisition_source || filters.source || 'unknown',
      recordSource: 'admin_audit_logs',
      severity: systemEventSeverity(audit.action),
      firstSeenAt: audit.created_at,
      lastSeenAt: audit.created_at,
    });
  }

  if (
    errorResult.truncated
    || analyticsResult.truncated
    || auditResult.truncated
    || sessionsTruncated
    || transactionsTruncated
  ) {
    addGroupedSystemLog(logsByKey, {
      key: `system:results-truncated:${filters.since}`,
      event: 'LOG_RESULTS_TRUNCATED',
      message: `At least one event source exceeded ${SYSTEM_LOG_SOURCE_LIMIT.toLocaleString('en-NG')} records; showing the newest records`,
      platform: filters.platform || 'all',
      source: filters.source || 'all',
      recordSource: 'reporting_guard',
      severity: 'warning',
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
  }

  return [...logsByKey.values()].sort((left, right) =>
    String(right.last_seen_at || '').localeCompare(String(left.last_seen_at || '')));
}

export async function listUserAccountHistory(supabaseAdmin, options = {}) {
  const userId = normalizeUuid(options.userId);
  if (!userId) throw new Error('A valid userId is required');
  const limit = normalizeHistoryLimit(options.limit);
  const sourceLimit = Math.min(1000, Math.max(200, limit * 4));

  const [auditResult, ledgerResult, transactionResult, authUsers] = await Promise.all([
    fetchOptionalRows(
      () => supabaseAdmin.from('admin_audit_logs')
        .select('id, admin_user_id, action, target_type, target_id, reason, before_data, after_data, created_at')
        .eq('target_type', 'user').eq('target_id', userId)
        .order('created_at', { ascending: false }),
      'admin_audit_logs',
      sourceLimit,
    ),
    fetchOptionalRows(
      () => supabaseAdmin.from('wallet_ledger')
        .select('id, user_id, transaction_id, delta, balance_after, entry_type, reason, actor_user_id, created_at')
        .eq('user_id', userId).order('created_at', { ascending: false }),
      'wallet_ledger',
      sourceLimit,
    ),
    fetchOptionalRows(
      () => supabaseAdmin.from('transactions').select('*')
        .eq('user_id', userId).order('created_at', { ascending: false }),
      'transactions',
      sourceLimit,
    ),
    listAllAuthUsers(supabaseAdmin),
  ]);

  const emailById = new Map(authUsers.map((user) => [user.id, user.email || user.id]));
  const entries = [];
  const purchaseTransactionIds = new Set(
    transactionResult.rows.filter(isPurchaseTransaction).map((transaction) => transaction.id).filter(Boolean),
  );

  for (const audit of auditResult.rows) {
    if (ledgerResult.available && ['credits.added', 'credits.deducted'].includes(audit.action)) continue;
    entries.push({
      id: `audit:${audit.id}`,
      userId,
      action: humanizeEventName(audit.action),
      detail: normalizeEventText(audit.reason, 'Administrative account change'),
      time: audit.created_at,
      actor: emailById.get(audit.admin_user_id) || 'Administrator',
      source: 'admin_audit_logs',
      severity: systemEventSeverity(audit.action),
    });
  }

  for (const transaction of transactionResult.rows) {
    if (!isPurchaseTransaction(transaction)) continue;
    const successful = isSuccessfulPayment(transaction);
    const status = String(transaction.status || (successful ? 'success' : 'pending')).toLowerCase();
    const credits = Math.max(0, normalizeCredits(
      transaction.package_credits_snapshot ?? transaction.credits,
    ));
    const amount = transactionAmount(transaction);
    const reference = normalizeEventText(transaction.reference || transaction.id, 'No reference');
    const packageName = normalizeEventText(
      transaction.package_name_snapshot || transaction.description,
      'Credit purchase',
    );
    entries.push({
      id: `transaction:${transaction.id}`,
      userId,
      action: successful ? 'Payment verified' : `Payment ${status}`,
      detail: `${packageName} · NGN ${amount.toLocaleString('en-NG')} · ${credits.toLocaleString('en-NG')} credits · ${reference}`,
      time: transactionDate(transaction),
      actor: normalizeEventText(transaction.payment_gateway, 'Payment system'),
      source: 'transactions',
      severity: successful ? 'info' : systemEventSeverity(status, 'warning'),
      delta: successful ? credits : 0,
    });
  }

  for (const ledger of ledgerResult.rows) {
    if (ledger.transaction_id && purchaseTransactionIds.has(ledger.transaction_id)) continue;
    const delta = Number(ledger.delta || 0);
    const isDeduction = delta < 0;
    const isAdminAdjustment = ledger.entry_type === 'admin_adjustment';
    entries.push({
      id: `ledger:${ledger.id}`,
      userId,
      action: isAdminAdjustment
        ? (isDeduction ? 'Credits removed' : 'Credits added')
        : humanizeEventName(ledger.entry_type || 'wallet change'),
      detail: `${normalizeEventText(ledger.reason, 'Wallet balance changed')} · ${delta >= 0 ? '+' : ''}${delta.toLocaleString('en-NG')} credits · balance ${normalizeCredits(ledger.balance_after).toLocaleString('en-NG')}`,
      time: ledger.created_at,
      actor: emailById.get(ledger.actor_user_id) || (isAdminAdjustment ? 'Administrator' : 'Morphly'),
      source: 'wallet_ledger',
      severity: isDeduction ? 'warning' : 'info',
      delta,
      balanceAfter: normalizeCredits(ledger.balance_after),
    });
  }

  entries.sort((left, right) => String(right.time || '').localeCompare(String(left.time || '')));
  return {
    entries: entries.slice(0, limit),
    dataHealth: {
      adminAuditAvailable: auditResult.available,
      walletLedgerAvailable: ledgerResult.available,
      transactionsAvailable: transactionResult.available,
      truncated: auditResult.truncated || ledgerResult.truncated || transactionResult.truncated,
    },
  };
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

export async function listAdminReferrals(supabaseAdmin, options = {}) {
  const requestedStatus = String(options.status || 'all').trim().toLowerCase();
  const authUsers = await listAllAuthUsers(supabaseAdmin);
  const emailById = new Map(authUsers.map((user) => [user.id, user.email || user.id]));

  const [referrals, profiles, bonusTransactions, rewardTransactions, auditLogs] = await Promise.all([
    fetchAllRows(
      () => supabaseAdmin.from('referrals').select('*').order('created_at', { ascending: false }),
      'referrals',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('users').select('id, referral_code, referred_by_user_id, account_status').order('created_at', { ascending: false }),
      'users',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('transactions')
        .select('id, user_id, credits, reference, status, created_at')
        .eq('transaction_type', 'signup_bonus')
        .order('created_at', { ascending: false }),
      'signup bonus transactions',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('transactions')
        .select('id, user_id, related_user_id, related_payment_id, credits, reference, status, refund_status, created_at')
        .eq('transaction_type', 'referral_reward')
        .order('created_at', { ascending: false }),
      'referral reward transactions',
    ),
    fetchAllRows(
      () => supabaseAdmin.from('referral_audit_logs').select('*').order('created_at', { ascending: false }),
      'referral audit logs',
    ),
  ]);

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const rewardById = new Map(rewardTransactions.map((transaction) => [transaction.id, transaction]));
  const qualifyingPurchaseIds = referrals.map((entry) => entry.qualified_purchase_id).filter(Boolean);
  let qualifyingPurchases = [];

  if (qualifyingPurchaseIds.length > 0) {
    qualifyingPurchases = await fetchAllRows(
      () => supabaseAdmin.from('transactions')
        .select('id, reference, user_id, package_name_snapshot, status, refund_status, verified_at, created_at')
        .in('id', qualifyingPurchaseIds)
        .order('created_at', { ascending: false }),
      'referral qualifying purchases',
    );
  }

  const purchaseById = new Map(qualifyingPurchases.map((transaction) => [transaction.id, transaction]));
  const filteredReferrals = referrals.filter((entry) => {
    if (requestedStatus === 'all') return true;
    if (requestedStatus === 'registered') return entry.status !== 'disqualified';
    if (requestedStatus === 'waiting') return entry.status === 'registered';
    return entry.status === requestedStatus;
  });

  return {
    referrals: filteredReferrals.map((entry) => {
      const purchase = purchaseById.get(entry.qualified_purchase_id) || null;
      const reward = rewardById.get(entry.reward_transaction_id) || null;
      const referrerProfile = profileById.get(entry.referrer_user_id);
      const referredProfile = profileById.get(entry.referred_user_id);

      return {
        id: entry.id,
        referralCodeUsed: entry.referral_code_used,
        referrerUserId: entry.referrer_user_id,
        referrerEmail: entry.referrer_user_id ? emailById.get(entry.referrer_user_id) || entry.referrer_user_id : 'Deleted user',
        referrerCode: referrerProfile?.referral_code || null,
        referrerStatus: referrerProfile?.account_status || 'deleted',
        referredUserId: entry.referred_user_id,
        referredEmail: emailById.get(entry.referred_user_id) || entry.referred_user_id,
        referredStatus: referredProfile?.account_status || 'deleted',
        status: entry.status,
        registeredAt: entry.created_at,
        qualifiedAt: entry.qualified_at,
        rewardedAt: entry.rewarded_at,
        disqualifiedAt: entry.disqualified_at,
        disqualificationReason: entry.disqualification_reason,
        refundWarning: Boolean(entry.refund_warning),
        suspicious: Boolean(entry.suspicious),
        suspiciousReason: entry.suspicious_reason,
        firstQualifyingPurchase: purchase ? {
          id: purchase.id,
          reference: purchase.reference,
          package: purchase.package_name_snapshot,
          status: purchase.status,
          refundStatus: purchase.refund_status || 'none',
          verifiedAt: purchase.verified_at || purchase.created_at,
        } : null,
        rewardTransaction: reward ? {
          id: reward.id,
          reference: reward.reference,
          credits: Number(reward.credits || 0),
          status: reward.status,
          createdAt: reward.created_at,
        } : null,
      };
    }),
    totals: {
      registrations: referrals.length,
      waitingForPurchase: referrals.filter((entry) => entry.status === 'registered').length,
      rewarded: referrals.filter((entry) => entry.status === 'rewarded').length,
      disqualified: referrals.filter((entry) => entry.status === 'disqualified').length,
      referralCreditsIssued: rewardTransactions
        .filter((transaction) => transaction.status === 'success')
        .reduce((sum, transaction) => sum + Number(transaction.credits || 0), 0),
      signupBonusesIssued: bonusTransactions.filter((transaction) => transaction.status === 'success').length,
      signupBonusCreditsIssued: bonusTransactions
        .filter((transaction) => transaction.status === 'success')
        .reduce((sum, transaction) => sum + Number(transaction.credits || 0), 0),
      suspicious: referrals.filter((entry) => entry.suspicious).length,
    },
    audit: auditLogs.slice(0, 250),
  };
}

export async function disqualifyAdminReferral(supabaseAdmin, payload) {
  const referralId = String(payload.referralId || '').trim();
  const adminUserId = String(payload.adminUserId || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!referralId || !adminUserId || reason.length < 3) {
    throw new Error('Referral, administrator and reason are required');
  }

  const { data, error } = await supabaseAdmin.rpc('admin_disqualify_referral', {
    p_admin: adminUserId,
    p_referral: referralId,
    p_reason: reason,
  });
  if (error) throw error;
  return data;
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
