import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adjustUserCredits } from '../../shared/admin-service.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.resolve(
    currentDirectory,
    '../../supabase/migrations/20260823210000_enable_admin_credit_deductions.sql',
  ),
  'utf8',
);
const dashboard = fs.readFileSync(
  path.resolve(currentDirectory, '../src/pages/AdminDashboard.tsx'),
  'utf8',
);
const staticDashboard = fs.readFileSync(
  path.resolve(currentDirectory, '../../morphly-admin-dashboard/index.html'),
  'utf8',
);
const staticDashboardApp = fs.readFileSync(
  path.resolve(currentDirectory, '../../morphly-admin-dashboard/app.js'),
  'utf8',
);
const adminHandler = fs.readFileSync(
  path.resolve(currentDirectory, '../server/admin-handler.js'),
  'utf8',
);

test('admin service forwards a negative credit adjustment with its audit fields', async () => {
  const calls = [];
  const supabaseAdmin = {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return {
        data: {
          userId: parameters.p_user,
          adjustment: parameters.p_amount,
          creditsAdded: 0,
          creditsDeducted: -parameters.p_amount,
          newCredits: 750,
        },
        error: null,
      };
    },
  };

  const result = await adjustUserCredits(supabaseAdmin, {
    adminUserId: 'admin-id',
    userId: 'user-id',
    adjustment: -250,
    reason: '  Billing correction  ',
    idempotencyKey: 'admin:adjustment-id',
  });

  assert.deepEqual(calls, [{
    name: 'admin_adjust_credits',
    parameters: {
      p_admin: 'admin-id',
      p_user: 'user-id',
      p_amount: -250,
      p_reason: 'Billing correction',
      p_key: 'admin:adjustment-id',
    },
  }]);
  assert.equal(result.creditsDeducted, 250);
  assert.equal(result.newCredits, 750);
});

test('admin service rejects zero, fractional, excessive, and unexplained adjustments', async () => {
  const supabaseAdmin = { rpc: async () => ({ data: null, error: null }) };
  const valid = {
    adminUserId: 'admin-id',
    userId: 'user-id',
    reason: 'Correction',
  };

  await assert.rejects(adjustUserCredits(supabaseAdmin, { ...valid, adjustment: 0 }), /non-zero integer/);
  await assert.rejects(adjustUserCredits(supabaseAdmin, { ...valid, adjustment: -1.5 }), /non-zero integer/);
  await assert.rejects(adjustUserCredits(supabaseAdmin, { ...valid, adjustment: 1_000_001 }), /non-zero integer/);
  await assert.rejects(
    adjustUserCredits(supabaseAdmin, { ...valid, adjustment: -1, reason: '' }),
    /reason .* required/i,
  );
});

test('database adjustment is serialized, overdraft-safe, idempotent, and audited', () => {
  assert.match(migration, /p_amount < -1000000 OR p_amount > 1000000/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /Idempotency key was already used for a different adjustment/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /IF v_new < 0/);
  assert.match(migration, /v_admin_role/);
  assert.match(migration, /Super admin access is required to remove credits/);
  assert.match(migration, /'credits\.added' ELSE 'credits\.deducted'/);
  assert.match(migration, /creditsDeducted/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated/);
});

test('admin dashboard exposes add and deduct modes and requires an audit reason', () => {
  assert.match(dashboard, /type CreditAdjustmentMode = 'add' \| 'deduct'/);
  assert.match(dashboard, /Deduct credits/);
  assert.match(dashboard, /creditAdjustmentMode === 'deduct' \? -parsedCredits : parsedCredits/);
  assert.match(dashboard, /This reason is saved in the admin audit log/);

  assert.match(staticDashboard, /data-credit-mode="add"/);
  assert.match(staticDashboard, /data-credit-mode="deduct"/);
  assert.match(staticDashboard, /Remove credits/);
  assert.match(staticDashboard, /creditDeductionConfirmation/);
  assert.match(staticDashboardApp, /mode === "deduct" \? -amount : amount/);
  assert.match(staticDashboardApp, /Only a super admin can remove credits/);
  assert.match(adminHandler, /adminContext\.admin\.role !== 'super_admin'/);
});

test('static dashboard reuses an operation key for retries and disables duplicate submissions', () => {
  assert.match(staticDashboardApp, /state\.creditOperation\.signature !== signature/);
  assert.match(staticDashboardApp, /return state\.creditOperation\.key/);
  assert.match(staticDashboardApp, /setCreditFormDisabled\(true\)/);
  assert.match(staticDashboardApp, /state\.creditOperation = null/);
  assert.match(staticDashboardApp, /state\.userHistory\.delete\(user\.id\)/);
  assert.match(staticDashboardApp, /AdminAPI\.userHistory\(userId, 100\)/);
});
