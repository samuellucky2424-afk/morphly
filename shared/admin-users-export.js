// @ts-nocheck
import { requireAdminContext } from './admin-auth.js';
import { listAdminUsers } from './admin-service.js';

const PAGE_SIZE = 1000;
const MAX_PROFILE_ROWS = 50000;
const SENSITIVE_KEY = /pass(word)?|token|secret|hash|salt|api[_-]?key|private|otp|recovery|refresh|session_key|credential/i;
const BASE_COLUMNS = [
  ['uid', (u) => u.id],
  ['email', (u) => u.email],
  ['display_name', (u) => u.name],
  ['created_at', (u) => u.createdAt],
  ['last_sign_in_at', (u) => u.lastSignInAt],
  ['credits', (u) => u.credits],
  ['plan', (u) => u.plan],
  ['account_status', (u) => u.status],
  ['is_admin', (u) => u.isAdmin],
  ['admin_role', (u) => u.adminRole],
  ['purchases_90d', (u) => u.purchases],
  ['spent_ngn_90d', (u) => u.spent],
  ['sessions_90d', (u) => u.sessions],
  ['session_success_rate_90d', (u) => u.successRate],
  ['platform', (u) => u.platform],
  ['acquisition_source', (u) => u.source],
];
const SKIP_PROFILE_KEYS = new Set(['id', 'email', 'created_at', 'account_status']);

/** Escape one CSV field (RFC 4180) and neutralise spreadsheet formula injection. */
export function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key));
}

export function buildUsersCsv(users, profilesById = new Map()) {
  const extraKeys = new Set();
  for (const profile of profilesById.values()) {
    for (const key of Object.keys(profile || {})) {
      if (!SKIP_PROFILE_KEYS.has(key) && !isSensitiveKey(key)) extraKeys.add(key);
    }
  }
  const extras = [...extraKeys].sort();
  const header = [...BASE_COLUMNS.map(([name]) => name), ...extras.map((key) => `profile_${key}`)];
  const lines = [header.map(escapeCsvField).join(',')];
  for (const user of users) {
    const profile = profilesById.get(user.id) || {};
    lines.push([
      ...BASE_COLUMNS.map(([, read]) => escapeCsvField(read(user))),
      ...extras.map((key) => escapeCsvField(profile[key])),
    ].join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

async function fetchAllProfiles(supabaseAdmin) {
  const byId = new Map();
  for (let from = 0; from < MAX_PROFILE_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin.from('users').select('*').order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) if (row?.id) byId.set(row.id, row);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return byId;
}

export async function handleAdminUsersExport(req, res, supabaseAdmin) {
  const adminContext = await requireAdminContext(req, res, supabaseAdmin);
  if (!adminContext) return;
  const [users, profilesById] = await Promise.all([
    listAdminUsers(supabaseAdmin, { days: 90 }),
    fetchAllProfiles(supabaseAdmin),
  ]);
  const csv = buildUsersCsv(users, profilesById);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=morphly-users-${date}.csv`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(csv);
}
