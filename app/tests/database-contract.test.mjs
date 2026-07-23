import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  currentDirectory,
  '../../supabase/20260723_onboarding_camera_referrals.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const signupCompatibilityHotfix = fs.readFileSync(
  path.resolve(
    currentDirectory,
    '../../supabase/20260723_fix_signup_transaction_schema.sql',
  ),
  'utf8',
);

test('Supabase extension functions are schema-qualified', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions/);
  assert.match(migration, /extensions\.gen_random_bytes\(8\)/);
  assert.match(migration, /extensions\.digest\(v_code, 'sha256'\)/);
  assert.doesNotMatch(migration, /DEFAULT uuid_generate_v4\(\)/);
});

test('historical non-zero monetary amount constraint is removed for bonus grants', () => {
  assert.match(
    migration,
    /pg_get_expr\(conbin, conrelid\)[\s\S]*ALTER TABLE public\.transactions DROP CONSTRAINT/,
  );
  assert.match(migration, /p_amount IS NULL OR p_amount <= 0/);
});

test('signup trigger transaction columns and historical type values are migration-safe', () => {
  for (const sql of [migration, signupCompatibilityHotfix]) {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS wallet_id UUID/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS amount_naira NUMERIC\(12,2\) NOT NULL DEFAULT 0/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS description TEXT/);
    assert.match(sql, /'credit_purchase'/);
    assert.match(sql, /'session_usage'/);
  }
});

test('new-user trigger grants exactly 50 credits with an idempotency reference', () => {
  assert.match(migration, /'signup_bonus:' \|\| NEW\.id::text/);
  assert.match(migration, /'New account testing credits'/);
  assert.match(migration, /v_balance_after := v_balance_after \+ 50/);
  assert.match(migration, /ON CONFLICT DO NOTHING\s+RETURNING id INTO v_signup_transaction_id/s);
});

test('existing users are backfilled with referral codes but not signup credits', () => {
  const backfillSection = migration.slice(
    migration.indexOf('DO $$\nDECLARE\n  v_user_id'),
    migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique'),
  );
  assert.match(backfillSection, /morphly_generate_referral_code/);
  assert.doesNotMatch(backfillSection, /signup_bonus|\+ 50/);
});

test('one immutable referral relationship exists per referred user', () => {
  assert.match(migration, /referred_user_id UUID NOT NULL UNIQUE/);
  assert.match(migration, /Referral relationship is immutable/);
  assert.match(migration, /INVALID_REFERRAL_CODE/);
});

test('referral reward is first-purchase-only, positive-payment-only and exactly 200 credits', () => {
  assert.match(migration, /v_is_first_purchase/);
  assert.match(migration, /COALESCE\(prior_purchase\.amount_naira, prior_purchase\.amount, 0\) > 0/);
  assert.match(migration, /'referral_reward:' \|\| p_user::text/);
  assert.match(migration, /v_referrer_new := v_referrer_old \+ 200/);
  assert.match(migration, /ON CONFLICT DO NOTHING\s+RETURNING id INTO v_reward_tx/s);
});

test('duplicate and concurrent payment processing are serialized and service-role-only', () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /transactions_reference_unique/);
  assert.match(migration, /auth\.role\(\) IS DISTINCT FROM 'service_role'/);
});

test('registration, pending/failed, bonuses and admin adjustments cannot qualify as purchases', () => {
  assert.match(migration, /transaction_type = 'credit_purchase'/);
  assert.match(migration, /prior_purchase\.package_id IS NOT NULL/);
  assert.match(migration, /IN \('success', 'successful', 'succeeded', 'completed', 'paid', 'verified'\)/);
  assert.doesNotMatch(
    migration.match(/SELECT NOT EXISTS \([\s\S]*?INTO v_is_first_purchase;/)?.[0] || '',
    /signup_bonus|admin_adjustment|referral_reward/,
  );
});

test('refunds create an admin-visible warning without automatic reward reversal', () => {
  assert.match(migration, /refund_warning = TRUE/);
  assert.match(migration, /'rewardAutomaticallyReversed', FALSE/);
});

test('credit writes and protected account fields are service-side only', () => {
  assert.match(migration, /DROP POLICY IF EXISTS "Users can update own wallet"/);
  assert.match(migration, /DROP POLICY IF EXISTS "Users can insert own transactions"/);
  assert.match(migration, /signup_bonus_welcome_shown_at IS DISTINCT FROM OLD\.signup_bonus_welcome_shown_at/);
});

test('high referral velocity is logged for admin review without blocking legitimate signup', () => {
  assert.match(migration, /v_recent_referral_count >= 9/);
  assert.match(migration, /'referral\.suspicious_velocity_detected'/);
  assert.match(migration, /'blocked', FALSE/);
});
