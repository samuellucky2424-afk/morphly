import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDirectory, '../..');
const migration = fs.readFileSync(
  path.join(workspaceRoot, 'supabase/20260728_decart_usage_audit.sql'),
  'utf8',
);
const startSession = fs.readFileSync(
  path.join(workspaceRoot, 'app/server/api/start-session.ts'),
  'utf8',
);
const dashboard = fs.readFileSync(
  path.join(workspaceRoot, 'app/src/pages/Dashboard.tsx'),
  'utf8',
);
const adminPortal = fs.readFileSync(
  path.join(workspaceRoot, 'morphly-admin-dashboard/app.js'),
  'utf8',
);
const adminPortalHtml = fs.readFileSync(
  path.join(workspaceRoot, 'morphly-admin-dashboard/index.html'),
  'utf8',
);
const appVercelConfig = fs.readFileSync(
  path.join(workspaceRoot, 'app/vercel.json'),
  'utf8',
);

test('AI usage is debited atomically and written to one durable ledger row per session', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_ai_session_usage/);
  assert.match(migration, /FROM public\.wallets[\s\S]*FOR UPDATE/);
  assert.match(migration, /'ai-session:' \|\| p_session::TEXT/);
  assert.match(migration, /ON CONFLICT \(idempotency_key\) DO UPDATE/);
  assert.match(migration, /wallet_debited_credits/);
});

test('AI billing RPCs are restricted to the service role', () => {
  assert.match(migration, /current_setting\('request\.jwt\.claim\.role', true\) IS DISTINCT FROM 'service_role'/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.record_ai_session_usage\(UUID, UUID, INTEGER\)[\s\S]*FROM PUBLIC, anon, authenticated/,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.finalize_ai_session\(UUID, UUID, INTEGER, TEXT\)[\s\S]*FROM PUBLIC, anon, authenticated/,
  );
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.wallets FROM anon, authenticated/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.transactions FROM anon, authenticated/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON public\.sessions FROM anon, authenticated/);
});

test('Decart client tokens are short-lived, scoped, rate-limited and attributable', () => {
  assert.match(startSession, /CLIENT_TOKEN_TTL_SECONDS = 60/);
  assert.match(startSession, /allowedModels: \[DECART_REALTIME_MODEL\]/);
  assert.match(startSession, /maxSessionDuration/);
  assert.match(startSession, /TOKEN_MINT_LIMIT_PER_WINDOW/);
  assert.match(startSession, /start-session\.unverified_wallet_blocked/);
  assert.match(startSession, /hasWalletCreditProvenance/);
  assert.match(startSession, /morphlyUserId: userId/);
  assert.match(startSession, /morphlySessionId: sessionId/);
  assert.match(startSession, /event_name: status === 'issued' \? 'decart_token_issued'/);
});

test('Decart cumulative generation ticks are no longer truncated to ten seconds', () => {
  assert.match(dashboard, /MAX_GENERATION_TICK_DELTA_SECONDS = 60/);
  assert.doesNotMatch(dashboard, /pendingBillableSecondsRef\.current \+= Math\.min\(secondsDelta, 10\)/);
});

test('private admin portal exposes per-user AI credit and generation-time reporting', () => {
  assert.match(adminPortalHtml, /data-view="usage"/);
  assert.match(adminPortalHtml, /AI credits and generation time by user/);
  assert.match(adminPortalHtml, /id="usageTableBody"/);
  assert.match(adminPortal, /usage: "\/api\/admin-usage"/);
  assert.match(adminPortal, /function renderUsage\(\)/);
  assert.match(adminPortal, /user\.walletCredits/);
  assert.match(adminPortal, /user\.recordedCredits/);
  assert.match(adminPortal, /user\.recordedSeconds/);
  assert.match(appVercelConfig, /"source": "\/api\/admin-usage"/);
});
