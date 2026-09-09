import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const billingSql = fs.readFileSync(new URL(
  '../../supabase/migrations/20260908120000_add_atomic_session_billing_functions.sql', import.meta.url,
), 'utf8');
const repairSql = fs.readFileSync(new URL(
  '../../supabase/migrations/20260909120000_fix_session_billing_role_check.sql', import.meta.url,
), 'utf8');
const userId = '00000000-0000-0000-0000-000000000001';
const sessionId = '00000000-0000-0000-0000-000000000002';

async function createDatabase(t, sql = billingSql) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    -- Supabase's helper accepts legacy settings and modern JSON claims.
    CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.role', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
      )
    $$;
    CREATE FUNCTION public.uuid_generate_v4() RETURNS UUID LANGUAGE SQL AS $$
      SELECT gen_random_uuid()
    $$;
    CREATE TABLE public.users (id UUID PRIMARY KEY);
    CREATE TABLE public.transactions (id UUID PRIMARY KEY);
    CREATE TABLE public.wallets (user_id UUID PRIMARY KEY, credits INTEGER NOT NULL);
    CREATE TABLE public.sessions (
      id UUID PRIMARY KEY, user_id UUID NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
      seconds_used INTEGER DEFAULT 0, end_time TIMESTAMPTZ
    );
    INSERT INTO public.users VALUES ('${userId}');
    INSERT INTO public.wallets VALUES ('${userId}', 100);
    INSERT INTO public.sessions (id, user_id, status) VALUES ('${sessionId}', '${userId}', 'active');
  `);
  await db.exec(sql);
  return db;
}

async function setClaims(db, role) {
  await db.query("SELECT set_config('request.jwt.claims', $1, false)", [
    JSON.stringify(role ? { role } : {}),
  ]);
}

async function record(db, seconds) {
  const result = await db.query('SELECT public.record_ai_session_usage($1, $2, $3) AS result',
    [userId, sessionId, seconds]);
  return result.rows[0].result;
}

async function finalize(db, seconds = 0) {
  const result = await db.query("SELECT public.finalize_ai_session($1, $2, $3, 'superseded') AS result",
    [userId, sessionId, seconds]);
  return result.rows[0].result;
}

test('upgrade reproduces the production failure and repairs both RPCs idempotently', async t => {
  const legacySql = billingSql.replaceAll('auth.role()', "current_setting('request.jwt.claim.role', true)");
  const db = await createDatabase(t, legacySql);
  await setClaims(db, 'service_role');
  await assert.rejects(record(db, 5), /Service role required/);
  await assert.rejects(finalize(db), /Service role required/);
  await db.exec(repairSql);
  await db.exec(repairSql);
  await db.exec('SET ROLE service_role');
  assert.equal((await record(db, 5)).remainingCredits, 90);
  assert.equal((await finalize(db)).remainingCredits, 90);
});

test('fresh installation meters usage and closes sessions without double charging', async t => {
  const db = await createDatabase(t);
  await setClaims(db, 'service_role');
  await db.exec('SET ROLE service_role');
  assert.equal((await record(db, 5)).creditsDebited, 10);
  const ended = await finalize(db, 2);
  assert.equal(ended.creditsDebited, 4);
  assert.equal(ended.remainingCredits, 86);
  assert.equal((await finalize(db, 2)).duplicate, true);
  await db.exec('RESET ROLE');
  const ledger = await db.query('SELECT delta, balance_after FROM public.wallet_ledger');
  assert.deepEqual(ledger.rows, [{ delta: -14, balance_after: 86 }]);
  const session = await db.query('SELECT status, seconds_used, wallet_debited_credits FROM public.sessions');
  assert.deepEqual(session.rows, [{ status: 'ended', seconds_used: 7, wallet_debited_credits: 14 }]);
});

test('closing an unused leftover session preserves credits', async t => {
  const db = await createDatabase(t);
  await setClaims(db, 'service_role');
  const result = await finalize(db);
  assert.equal(result.remainingCredits, 100);
  assert.equal(result.creditsDebited, 0);
  assert.equal((await db.query('SELECT * FROM public.wallet_ledger')).rows.length, 0);
});

test('repaired RPCs still reject missing and non-service claims and client execution', async t => {
  const db = await createDatabase(t);
  await db.exec(repairSql);
  for (const role of [null, 'anon', 'authenticated']) {
    await setClaims(db, role);
    await assert.rejects(record(db, 5), /Service role required/);
    await assert.rejects(finalize(db), /Service role required/);
  }
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(record(db, 5), /permission denied for function/);
    await assert.rejects(finalize(db), /permission denied for function/);
    await db.exec('RESET ROLE');
  }
  assert.equal((await db.query('SELECT credits FROM public.wallets')).rows[0].credits, 100);
});

test('legacy claim format remains supported', async t => {
  const db = await createDatabase(t);
  await db.exec("SET request.jwt.claim.role = 'service_role'");
  assert.equal((await record(db, 1)).remainingCredits, 98);
  assert.equal((await finalize(db)).remainingCredits, 98);
});
