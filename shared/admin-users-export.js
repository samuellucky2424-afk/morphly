// @ts-nocheck
import { requireAdminContext } from './admin-auth.js';

const PAGE_SIZE = 1000;
const SENSITIVE_KEY = /pass(word)?|token|secret|hash|salt|api[_-]?key|private|otp|recovery|refresh|session_key|credential|signature|ticket|card|cvv|pin$/i;
const SUCCESS = new Set(['success', 'successful', 'succeeded', 'completed', 'paid', 'verified']);
const PURCHASE_TYPES = new Set(['credit', 'credit_purchase', 'purchase', 'payment']);
const FAILED_SESSION = new Set(['failed', 'error', 'interrupted']);
export const EXPORT_TYPES = ['summary', 'transactions', 'sessions', 'wallet-ledger'];

/** Escape one CSV field (RFC 4180) and neutralise spreadsheet formula injection. */
export function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value?.toDate === 'function') text = value.toDate().toISOString();
  else if (typeof value === 'object') text = JSON.stringify(stripSecrets(value));
  else text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function isSensitiveKey(key) { return SENSITIVE_KEY.test(String(key)); }

export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object' || typeof value.toDate === 'function') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !isSensitiveKey(k)).map(([k, v]) => [k, stripSecrets(v)]));
}

export function csvRow(values) { return `${values.map(escapeCsvField).join(',')}\r\n`; }

function ts(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const minIso = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/** Page through a whole Firestore collection by document id. */
export async function* scanCollection(db, name) {
  let last = null;
  while (true) {
    let query = db.collection(name).orderBy('__name__').limit(PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) yield { id: doc.id, ...doc.data() };
    if (snapshot.docs.length < PAGE_SIZE) return;
    last = snapshot.docs[snapshot.docs.length - 1];
  }
}

async function* scanOptional(db, name) {
  try { yield* scanCollection(db, name); } catch (error) {
    if (!/not found|NOT_FOUND|does not exist/i.test(String(error?.message))) throw error;
  }
}

/** Page through every Firebase Auth user (1000 per page). */
export async function* listAuthUsers(auth) {
  let pageToken;
  do {
    const result = await auth.listUsers(PAGE_SIZE, pageToken);
    for (const user of result.users) yield user;
    pageToken = result.pageToken;
  } while (pageToken);
}

function blankStats() {
  return {
    purchases: 0, spentByCurrency: {}, firstPurchaseAt: null, lastPurchaseAt: null, latestPlan: null, latestPlanAt: null,
    transactions: 0, failedPayments: 0, refunds: 0, paymentGateways: new Set(),
    creditsBought: 0, creditsUsed: 0, creditsGranted: 0, creditsRemoved: 0, ledgerEntries: 0,
    sessions: 0, successfulSessions: 0, sessionSeconds: 0, sessionCredits: 0, lastSessionAt: null, providers: new Set(), sessionPlatforms: new Set(),
    platforms: new Set(), latestPlatform: null, latestSource: null, latestEventAt: null, firstSource: null, firstEventAt: null,
    referralsMade: 0, referralsQualified: 0, referredBy: null, referralStatus: null,
  };
}

export function accumulateTransaction(stats, t) {
  stats.transactions += 1;
  const status = String(t.status || '').toLowerCase();
  const created = ts(t.created_at);
  if (t.payment_gateway || t.gateway || t.provider) stats.paymentGateways.add(String(t.payment_gateway || t.gateway || t.provider));
  if (t.refund_status || status === 'refunded') stats.refunds += 1;
  if (PURCHASE_TYPES.has(String(t.type || '').toLowerCase())) {
    if (SUCCESS.has(status)) {
      stats.purchases += 1;
      const currency = String(t.currency || (t.amount_naira != null ? 'NGN' : 'NGN')).toUpperCase();
      stats.spentByCurrency[currency] = num(stats.spentByCurrency[currency]) + num(t.amount_naira ?? t.amount);
      stats.firstPurchaseAt = minIso(stats.firstPurchaseAt, created);
      stats.lastPurchaseAt = maxIso(stats.lastPurchaseAt, created);
      if (t.package_name_snapshot && (!stats.latestPlanAt || (created && created > stats.latestPlanAt))) {
        stats.latestPlan = t.package_name_snapshot; stats.latestPlanAt = created;
      }
    } else if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) stats.failedPayments += 1;
  }
}

export function accumulateLedger(stats, e) {
  stats.ledgerEntries += 1;
  const delta = num(e.delta);
  const type = String(e.entry_type || '');
  if (type === 'package_purchase' && delta > 0) stats.creditsBought += delta;
  else if (delta < 0 && /usage/.test(type)) stats.creditsUsed += -delta;
  else if (delta > 0) stats.creditsGranted += delta;
  else if (delta < 0) stats.creditsRemoved += -delta;
}

export function accumulateSession(stats, s) {
  stats.sessions += 1;
  if (!FAILED_SESSION.has(String(s.status || '').toLowerCase())) stats.successfulSessions += 1;
  stats.sessionSeconds += num(s.seconds_used);
  stats.sessionCredits += num(s.credits_used ?? s.cost);
  stats.lastSessionAt = maxIso(stats.lastSessionAt, ts(s.created_at || s.start_time));
  if (s.provider) stats.providers.add(String(s.provider));
  if (s.platform) stats.sessionPlatforms.add(String(s.platform));
}

function accumulateEvent(stats, e) {
  const at = ts(e.created_at);
  if (e.platform) stats.platforms.add(String(e.platform));
  if (at && (!stats.latestEventAt || at > stats.latestEventAt)) {
    stats.latestEventAt = at; stats.latestPlatform = e.platform || stats.latestPlatform; stats.latestSource = e.acquisition_source || stats.latestSource;
  }
  if (at && e.acquisition_source && (!stats.firstEventAt || at < stats.firstEventAt)) { stats.firstEventAt = at; stats.firstSource = e.acquisition_source; }
}

const SUMMARY_COLUMNS = [
  'uid', 'email', 'email_verified', 'display_name', 'phone_number', 'photo_url', 'disabled', 'auth_providers', 'custom_claims',
  'created_at', 'last_sign_in_at', 'last_refresh_at', 'account_status', 'is_admin', 'admin_role',
  'current_credits', 'credits_bought_total', 'credits_used_total', 'credits_granted_total', 'credits_removed_total', 'wallet_ledger_entries',
  'purchases_total', 'spent_by_currency', 'first_purchase_at', 'last_purchase_at', 'latest_plan', 'transactions_total', 'failed_payments', 'refunds', 'payment_gateways',
  'sessions_total', 'successful_sessions', 'session_success_rate_pct', 'session_seconds_total', 'session_credits_total', 'last_session_at', 'session_providers', 'session_platforms',
  'platforms_seen', 'latest_platform', 'latest_acquisition_source', 'first_acquisition_source',
  'referrals_made', 'referrals_qualified', 'referred_by_uid', 'referral_status',
];

export function buildSummaryHeader(prefixedKeys) { return [...SUMMARY_COLUMNS, ...prefixedKeys]; }

export function summaryValues(authUser, stats, extras, prefixedKeys) {
  const s = stats || blankStats();
  const claims = stripSecrets(authUser.customClaims || {});
  const values = {
    uid: authUser.uid, email: authUser.email, email_verified: Boolean(authUser.emailVerified), display_name: authUser.displayName,
    phone_number: authUser.phoneNumber, photo_url: authUser.photoURL, disabled: Boolean(authUser.disabled),
    auth_providers: (authUser.providerData || []).map((p) => p.providerId).join('|'),
    custom_claims: Object.keys(claims).length ? claims : null,
    created_at: ts(authUser.metadata?.creationTime), last_sign_in_at: ts(authUser.metadata?.lastSignInTime), last_refresh_at: ts(authUser.metadata?.lastRefreshTime),
    account_status: extras.profile?.account_status || 'active', is_admin: Boolean(extras.admin), admin_role: extras.admin?.role || null,
    current_credits: num(extras.wallet?.credits), credits_bought_total: s.creditsBought, credits_used_total: s.creditsUsed,
    credits_granted_total: s.creditsGranted, credits_removed_total: s.creditsRemoved, wallet_ledger_entries: s.ledgerEntries,
    purchases_total: s.purchases, spent_by_currency: Object.entries(s.spentByCurrency).map(([c, v]) => `${c}:${v}`).join('|'),
    first_purchase_at: s.firstPurchaseAt, last_purchase_at: s.lastPurchaseAt, latest_plan: s.latestPlan || 'Credits',
    transactions_total: s.transactions, failed_payments: s.failedPayments, refunds: s.refunds, payment_gateways: [...s.paymentGateways].join('|'),
    sessions_total: s.sessions, successful_sessions: s.successfulSessions,
    session_success_rate_pct: s.sessions ? Math.round((s.successfulSessions / s.sessions) * 100) : 0,
    session_seconds_total: s.sessionSeconds, session_credits_total: s.sessionCredits, last_session_at: s.lastSessionAt,
    session_providers: [...s.providers].join('|'), session_platforms: [...s.sessionPlatforms].join('|'),
    platforms_seen: [...s.platforms].join('|'), latest_platform: s.latestPlatform, latest_acquisition_source: s.latestSource, first_acquisition_source: s.firstSource,
    referrals_made: s.referralsMade, referrals_qualified: s.referralsQualified, referred_by_uid: s.referredBy, referral_status: s.referralStatus,
  };
  const row = SUMMARY_COLUMNS.map((c) => values[c]);
  for (const key of prefixedKeys) {
    const [prefix, ...rest] = key.split('_'); const field = rest.join('_');
    const source = { profile: extras.profile, wallet: extras.wallet, emailprefs: extras.emailPrefs, subscription: extras.subscription }[prefix];
    row.push(source ? source[field] : null);
  }
  return row;
}

function trackKeys(set, prefix, doc, skip = []) {
  for (const key of Object.keys(doc || {})) if (!isSensitiveKey(key) && !skip.includes(key)) set.add(`${prefix}_${key}`);
}

async function writeSummary(res, db, auth) {
  const stats = new Map();
  const get = (uid) => { if (!stats.has(uid)) stats.set(uid, blankStats()); return stats.get(uid); };
  const profiles = new Map(), wallets = new Map(), admins = new Map(), emailPrefs = new Map(), subscriptions = new Map();
  const keys = new Set();
  for await (const p of scanOptional(db, 'users')) { profiles.set(p.id, p); trackKeys(keys, 'profile', p, ['id']); }
  for await (const w of scanOptional(db, 'wallets')) { if (w.user_id) { wallets.set(w.user_id, w); trackKeys(keys, 'wallet', w, ['id', 'user_id']); } }
  for await (const a of scanOptional(db, 'admin_users')) { if (a.user_id && a.is_active !== false) admins.set(a.user_id, a); }
  for await (const e of scanOptional(db, 'customer_email_preferences')) { const uid = e.user_id || e.id; emailPrefs.set(uid, e); trackKeys(keys, 'emailprefs', e, ['id', 'user_id']); }
  for await (const s of scanOptional(db, 'subscriptions')) {
    if (!s.user_id) continue;
    const prev = subscriptions.get(s.user_id);
    if (!prev || String(ts(s.created_at)) > String(ts(prev.created_at))) subscriptions.set(s.user_id, s);
    trackKeys(keys, 'subscription', s, ['id', 'user_id']);
  }
  for await (const t of scanOptional(db, 'transactions')) if (t.user_id) accumulateTransaction(get(t.user_id), t);
  for await (const e of scanOptional(db, 'wallet_ledger')) if (e.user_id) accumulateLedger(get(e.user_id), e);
  for await (const s of scanOptional(db, 'sessions')) if (s.user_id) accumulateSession(get(s.user_id), s);
  for await (const e of scanOptional(db, 'analytics_events')) if (e.user_id) accumulateEvent(get(e.user_id), e);
  for await (const r of scanOptional(db, 'referrals')) {
    if (r.referrer_user_id) { const s = get(r.referrer_user_id); s.referralsMade += 1; if (r.qualified_at || r.status === 'qualified' || r.status === 'rewarded') s.referralsQualified += 1; }
    if (r.referred_user_id) { const s = get(r.referred_user_id); s.referredBy = r.referrer_user_id || null; s.referralStatus = r.status || null; }
  }
  const prefixedKeys = [...keys].sort();
  res.write(`\uFEFF${csvRow(buildSummaryHeader(prefixedKeys))}`);
  for await (const user of listAuthUsers(auth)) {
    res.write(csvRow(summaryValues(user, stats.get(user.uid), {
      profile: profiles.get(user.uid), wallet: wallets.get(user.uid), admin: admins.get(user.uid),
      emailPrefs: emailPrefs.get(user.uid), subscription: subscriptions.get(user.uid),
    }, prefixedKeys)));
  }
}

async function writeRecords(res, db, auth, collection) {
  const emails = new Map();
  for await (const user of listAuthUsers(auth)) emails.set(user.uid, user.email || '');
  // Discover the column set from a first pass of keys, then stream rows page by page.
  const keys = new Set();
  for await (const doc of scanOptional(db, collection)) for (const k of Object.keys(doc)) if (!isSensitiveKey(k) && k !== 'user_id') keys.add(k);
  const columns = [...keys].sort();
  res.write(`\uFEFF${csvRow(['uid', 'email', ...columns])}`);
  for await (const doc of scanOptional(db, collection)) {
    res.write(csvRow([doc.user_id || '', emails.get(doc.user_id) || '', ...columns.map((c) => doc[c])]));
  }
}

export async function handleAdminUsersExport(req, res, supabaseAdmin) {
  const adminContext = await requireAdminContext(req, res, supabaseAdmin);
  if (!adminContext) return;
  const rawType = Array.isArray(req.query?.type) ? req.query.type[0] : req.query?.type;
  const type = EXPORT_TYPES.includes(rawType) ? rawType : 'summary';
  const db = supabaseAdmin.db, auth = supabaseAdmin.authAdmin;
  if (!db || !auth) return res.status(503).json({ error: 'User export requires the Firebase admin backend' });
  const date = new Date().toISOString().slice(0, 10);
  const name = type === 'summary' ? 'users' : type;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=morphly-${name}-${date}.csv`);
  res.setHeader('Cache-Control', 'no-store');
  if (type === 'summary') await writeSummary(res, db, auth);
  else await writeRecords(res, db, auth, type === 'wallet-ledger' ? 'wallet_ledger' : type);
  res.end();
}
