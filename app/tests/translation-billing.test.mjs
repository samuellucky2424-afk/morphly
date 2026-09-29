import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const user = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const session = '00000000-0000-0000-0000-000000000003';
async function database(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    CREATE TABLE public.users(id UUID PRIMARY KEY);
    CREATE TABLE public.sessions(id UUID PRIMARY KEY, user_id UUID, status TEXT DEFAULT 'active', start_time TIMESTAMPTZ DEFAULT clock_timestamp()-interval '60 seconds', end_time TIMESTAMPTZ, seconds_used INTEGER DEFAULT 0, provider_max_seconds INTEGER, last_usage_at TIMESTAMPTZ);
    CREATE FUNCTION public.finalize_ai_session(UUID,UUID,INTEGER,TEXT) RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.record_ai_session_usage(UUID,UUID,INTEGER) RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.wallets(user_id UUID PRIMARY KEY, credits INTEGER NOT NULL);
    CREATE TABLE public.wallet_ledger(user_id UUID, delta INTEGER, balance_after INTEGER, entry_type TEXT, reason TEXT, idempotency_key TEXT UNIQUE);
    INSERT INTO public.users VALUES ('${user}'), ('${other}');
    INSERT INTO public.wallets VALUES ('${user}', 100), ('${other}', 100);
    SELECT set_config('request.jwt.claim.role', 'service_role', false);
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/20260929120000_add_combined_realtime_billing.sql', import.meta.url), 'utf8'));
  return db;
}
async function authorize(db, seconds, close = false, owner = user) {
  const { rows } = await db.query('SELECT public.authorize_translation_usage($1,$2,$3,$4) AS result', [owner, session, seconds, close]);
  return rows[0].result;
}

test('translation reserves 2.5 credits/sec once, refunds unused seconds, and finalizes idempotently', async t => {
  const db = await database(t);
  assert.equal((await authorize(db, 5)).remainingCredits, 87.5);
  assert.equal((await authorize(db, 5)).remainingCredits, 87.5);
  assert.equal((await authorize(db, 2, true)).remainingCredits, 95);
  assert.equal((await authorize(db, 2, true)).remainingCredits, 95);
  assert.equal((await authorize(db, 5)).closed, true);
  assert.equal(Number((await db.query('SELECT SUM(cost_half)/2.0 AS cost FROM realtime_usage_seconds')).rows[0].cost), 5);
});

test('insufficient funds authorize only affordable whole seconds and never make balances negative', async t => {
  const db = await database(t);
  await db.query('UPDATE wallets SET credits = 7 WHERE user_id = $1', [user]);
  const result = await authorize(db, 5);
  assert.equal(result.authorizedSeconds, 2);
  assert.equal(result.remainingCredits, 2);
  assert.equal((await authorize(db, 5)).remainingCredits, 2);
});

test('billing enforces ownership, server role and bounded reservations', async t => {
  const db = await database(t);
  await authorize(db, 5);
  await assert.rejects(authorize(db, 5, false, other), /ownership/);
  await assert.rejects(authorize(db, -1), /Invalid translation duration/);
  await assert.rejects(authorize(db, 100), /too far ahead/);
  await db.exec("SELECT set_config('request.jwt.claim.role', 'authenticated', false)");
  await assert.rejects(authorize(db, 5), /Service role required/);
  await db.exec('SET ROLE authenticated');
  await assert.rejects(authorize(db, 5), /permission denied/);
  await assert.rejects(db.query('SELECT * FROM translation_sessions'), /permission denied/);
});

test('ending before audio runs refunds the entire reservation', async t => {
  const db = await database(t);
  await authorize(db, 5);
  assert.equal((await authorize(db, 0, true)).remainingCredits, 100);
});

test('one second costs exactly 2.5; the half credit remains spendable across sessions', async t => {
  const db = await database(t);
  assert.equal((await authorize(db, 1)).remainingCredits, 97.5);
  await authorize(db, 1, true);
  assert.deepEqual((await db.query('SELECT credits FROM wallets WHERE user_id=$1',[user])).rows,[{credits:97}]);
  assert.deepEqual((await db.query('SELECT half_credit FROM realtime_credit_carry')).rows,[{half_credit:1}]);
});

for (const videoFirst of [false,true]) test(`ten seconds of simultaneous video and translation cost 40 total, video first=${videoFirst}`, async t => {
  const db=await database(t), video='11111111-1111-4111-8111-111111111111';
  await db.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)',[video,user]);
  await db.query('SELECT configure_realtime_video($1,$2,5)',[user,video]);
  const epoch=Number((await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())) AS sec')).rows[0].sec)-15;
  await db.query('INSERT INTO translation_sessions(id,user_id,started_epoch) VALUES($1,$2,$3)',[session,user,epoch]);
  const seconds=Array.from({length:10},(_,i)=>epoch+i);
  const record=()=>db.query('SELECT record_realtime_video_usage($1,$2,$3,false) AS result',[user,video,seconds]);
  if(videoFirst) await record();
  await authorize(db,10);
  await record();
  await record(); // Duplicate heartbeat must not charge again.
  assert.equal((await authorize(db,10,true)).remainingCredits,60);
  const {rows}=await db.query('SELECT finalize_ai_session($1,$2,10,\'test\') AS result',[user,video]);
  assert.equal(rows[0].result.remainingCredits,60); // Legacy finalizer cannot double-bill v2.
});

test('unused translation reservations refund only translation while retaining video charges', async t => {
  const db=await database(t),video='11111111-1111-4111-8111-111111111111';
  await db.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)',[video,user]);
  await db.query('SELECT configure_realtime_video($1,$2,5)',[user,video]);
  const epoch=Number((await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())) AS sec')).rows[0].sec);
  await authorize(db,5);
  await db.query('SELECT record_realtime_video_usage($1,$2,$3,false)',[user,video,[epoch]]);
  assert.equal((await authorize(db,0,true)).remainingCredits,97.5);
});

test('insufficient combined credit cannot make balance negative; cross-account and future ticks are rejected', async t => {
  const db=await database(t),video='11111111-1111-4111-8111-111111111111';
  await db.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)',[video,user]);
  await db.query('SELECT configure_realtime_video($1,$2,5)',[user,video]);
  const epoch=Number((await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())) AS sec')).rows[0].sec);
  await db.query('UPDATE wallets SET credits=3 WHERE user_id=$1',[user]);
  await authorize(db,1);
  const r=await db.query('SELECT record_realtime_video_usage($1,$2,$3,false) AS result',[user,video,[epoch]]);
  assert.equal(r.rows[0].result.shouldStop,true);
  assert.equal(r.rows[0].result.remainingCredits,.5);
  await assert.rejects(db.query('SELECT record_realtime_video_usage($1,$2,$3,false)',[other,video,[epoch]]),/ownership/);
  await assert.rejects(db.query('SELECT record_realtime_video_usage($1,$2,$3,false)',[user,video,[epoch+60]]),/timestamp/);
});

test('translation starts and stops during Plus video with per-second blended rates', async t => {
  const db=await database(t), video='11111111-1111-4111-8111-111111111111';
  await db.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)',[video,user]);
  await db.query('SELECT configure_realtime_video($1,$2,4)',[user,video]);
  const epoch=Number((await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())) AS sec')).rows[0].sec)-20;
  const seconds=Array.from({length:10},(_,i)=>epoch+i);
  await db.query('INSERT INTO translation_sessions(id,user_id,started_epoch) VALUES($1,$2,$3)',[session,user,epoch+3]);
  await authorize(db,6);
  await db.query('SELECT record_realtime_video_usage($1,$2,$3,false,false,$4)',[user,video,seconds,[epoch,epoch+8]]);
  await authorize(db,4,true); // Only seconds 3..6 overlap.
  const balance=await db.query('SELECT realtime_wallet_balance($1) AS balance',[user]);
  // 4 overlap*4 + 2 blended*4 + 4 plain*2 = 32 total.
  assert.equal(Number(balance.rows[0].balance),68);
});

test('an expired relay lease cannot block translation restart indefinitely', async t => {
  const db=await database(t), next='11111111-1111-4111-8111-111111111111';
  await authorize(db,5);
  await assert.rejects(db.query('SELECT authorize_translation_usage($1,$2,1)',[user,next]),/unique/);
  await db.query("UPDATE translation_sessions SET started_epoch=started_epoch-60 WHERE id=$1",[session]);
  const result=await db.query('SELECT authorize_translation_usage($1,$2,1) AS result',[user,next]);
  assert.equal(result.rows[0].result.authorizedSeconds,1);
  assert.equal((await db.query('SELECT closed_at IS NOT NULL AS closed FROM translation_sessions WHERE id=$1',[session])).rows[0].closed,true);
});
