import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { cronAuthorized, renderEngagementEmail, sendResendEmail, validateAnnouncement, validateReview, deliverCustomerEmails } from '../server/customer-engagement.js';

const userId = '11111111-1111-4111-8111-111111111111';
const purchaseId = '22222222-2222-4222-8222-222222222222';
const reviewId = '33333333-3333-4333-8333-333333333333';
const token = '44444444-4444-4444-8444-444444444444';

test('reviews validate content, IDs and optional rating before persistence', () => {
  assert.equal(validateReview({ id: reviewId, category: 'issue', message: '  Audio crackles during a stream  ' }).message, 'Audio crackles during a stream');
  for (const changes of [{ id: 'wrong' }, { message: 'short' }, { message: 'x'.repeat(4001) }, { rating: 6 }, { rating: '5' }, { category: '<script>' }]) {
    assert.throws(() => validateReview({ id: reviewId, category: 'experience', message: 'A useful experience', ...changes }));
  }
});
test('maintenance windows reject invalid times and preserve plain text', () => {
  const now = new Date('2026-09-05T10:00:00Z');
  const input = { title: 'Maintenance', message: 'Back shortly', kind: 'maintenance', endsAt: '2026-09-05T11:00:00Z' };
  assert.equal(validateAnnouncement(input, now).ends_at, input.endsAt.replace('Z', '.000Z'));
  assert.throws(() => validateAnnouncement({ ...input, endsAt: 'yesterday' }, now));
  assert.throws(() => validateAnnouncement({ ...input, startsAt: '2026-09-05T12:00:00Z' }, now));
  assert.throws(() => validateAnnouncement({ ...input, endsAt: '2026-09-05T09:00:00Z' }, now));
});
test('emails include the website, an opt-out for customers, and escape review HTML', () => {
  for (const kind of ['signup_checkin','purchase_feedback','credits_finished','subscription_finished','first_purchase_reminder']) {
    const mail = renderEngagementEmail({ kind, email: 'user@example.com', from: 'Morphly <feedback@example.com>', unsubscribeToken: token });
    assert.deepEqual(mail.to, ['user@example.com']);
    assert.match(mail.html, /https:\/\/live\.morphly\.fun/);
    assert.match(mail.text, /https:\/\/live\.morphly\.fun/);
    assert.match(mail.html, /email-preferences\?token=/);
    assert.equal(mail.reply_to, 'samuellucky2424@gmail.com');
  }
  const mail = renderEngagementEmail({ kind: 'admin_review', review: { email: 'user@example.com', category: 'issue', rating: 2, message: '<script>alert("bad")</script>' } });
  assert.deepEqual(mail.to, ['samuellucky2424@gmail.com']);
  assert.equal(mail.reply_to, 'user@example.com');
  assert.ok(!mail.html.includes('<script>'));
  assert.match(mail.html, /&lt;script&gt;/);
});
test('Resend retries use a stable idempotency key and never expose provider bodies', async () => {
  const calls = [];
  const options = { apiKey: 'test-only', fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 }); } };
  const payload = { to: ['test@example.com'], subject: 'hello' };
  await sendResendEmail(payload, reviewId, options); await sendResendEmail(payload, reviewId, options);
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  await assert.rejects(sendResendEmail(payload, reviewId, { apiKey: 'test-only', fetchImpl: async () => new Response(JSON.stringify({ message: 'private provider data' }), { status: 429 }) }), /^Error: Resend delivery failed \(HTTP 429\)$/);
  assert.equal(cronAuthorized('Bearer secret', 'secret'), true);
  assert.equal(cronAuthorized('Bearer wrong', 'secret'), false);
  assert.equal(cronAuthorized('Bearer ', ''), false);
});
test('email setup missing does not claim jobs or block customer operations', async () => {
  const result = await deliverCustomerEmails({ rpc: () => { throw new Error('must not claim'); } }, { env: {} });
  assert.deepEqual(result, { configured: false, sent: 0 });
});

function deliveryFixture(overrides = {}) {
  const updates = []; const sends = [];
  const job = { id: reviewId, user_id: userId, source_id: purchaseId, kind: 'first_purchase_reminder', lease_id: token, attempts: 1, ...overrides.job };
  let claimed = false;
  const db = {
    rpc: async () => ({ data: claimed ? [] : (claimed = true, [job]) }),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'signup@example.com', email_confirmed_at: new Date().toISOString(), ...overrides.user } } }) } },
    from(table) {
      const values = {
        users: { account_status: 'active', ...overrides.profile },
        customer_email_preferences: { enabled: true, unsubscribe_token: token, ...overrides.preferences },
        transactions: overrides.purchases || [{ id: purchaseId, status: 'success', refund_status: 'none' }],
        wallets: { credits: overrides.credits ?? 0 },
        subscriptions: overrides.subscription || { status: 'expired', ends_at: '2026-01-01' },
        customer_reviews: { email: 'signup@example.com', category: 'issue', message: 'My microphone is not working.', rating: 2 },
      };
      const query = {
        select() { return this; }, eq() { return this; }, or() { return this; }, in() { return this; },
        single() { return this; }, maybeSingle() { return this; }, upsert() { return this; },
        update(value) { updates.push(value); return this; },
        then(resolve, reject) { return Promise.resolve({ data: values[table] ?? null }).then(resolve, reject); },
      };
      return query;
    },
  };
  const options = { env: { RESEND_API_KEY: 'test-only', RESEND_FROM_EMAIL: 'Morphly <test@example.com>' }, fetchImpl: async (url, init) => {
    sends.push(JSON.parse(init.body));
    if (overrides.fail) return new Response('{}', { status: 503 });
    return new Response('{"id":"email-1"}', { status: 200 });
  } };
  return { db, options, updates, sends };
}

test('worker rechecks opt-out, account, repurchase, refund, renewal and wallet before sending', async () => {
  for (const overrides of [
    { preferences: { enabled: false } },
    { user: { email_confirmed_at: null } },
    { profile: { account_status: 'suspended' } },
    { purchases: [{ id: purchaseId, status: 'success' }, { id: token, status: 'completed' }] },
    { purchases: [{ id: purchaseId, status: 'success', refund_status: 'refunded' }] },
    { job: { kind: 'credits_finished' }, credits: 50 },
    { job: { kind: 'subscription_finished' }, subscription: { status: 'active', ends_at: '2099-01-01' } },
  ]) {
    const { db, options, sends, updates } = deliveryFixture(overrides);
    const result = await deliverCustomerEmails(db, options);
    assert.equal(result.cancelled, 1); assert.equal(sends.length, 0);
    assert.equal(updates.at(-1).status, 'cancelled');
  }
});

test('worker delivers to the account email, preserves retry payloads and queues failures safely', async () => {
  const eligible = deliveryFixture();
  assert.equal((await deliverCustomerEmails(eligible.db, eligible.options)).sent, 1);
  assert.deepEqual(eligible.sends[0].to, ['signup@example.com']);
  assert.equal(eligible.updates.at(-1).provider_id, 'email-1');
  const failed = deliveryFixture({ fail: true });
  assert.equal((await deliverCustomerEmails(failed.db, failed.options)).failed, 1);
  assert.equal(failed.updates.at(-1).status, 'pending');
  assert.ok(Date.parse(failed.updates.at(-1).due_at) > Date.now());
  const payload = failed.updates[0].payload;
  const retry = deliveryFixture({ job: { payload } });
  await deliverCustomerEmails(retry.db, retry.options);
  assert.deepEqual(retry.sends[0], payload);
  const admin = deliveryFixture({ job: { kind: 'admin_review' }, preferences: { enabled: false } });
  await deliverCustomerEmails(admin.db, admin.options);
  assert.deepEqual(admin.sends[0].to, ['samuellucky2424@gmail.com']);
});

test('database triggers, deduplication, reminders, rate limits, RLS and recovery work in PostgreSQL', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid, type text, transaction_type text, status text, refund_status text, created_at timestamptz DEFAULT now());
    CREATE TABLE public.wallets(user_id uuid PRIMARY KEY, credits integer);
    CREATE TABLE public.subscriptions(id uuid PRIMARY KEY, user_id uuid, status text, ends_at timestamptz);
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/20260905120000_customer_engagement.sql', import.meta.url), 'utf8'));
  await db.query('INSERT INTO auth.users(id,email,email_confirmed_at,created_at) VALUES($1,$2,now(),now()-interval \'30 days\')', [userId,'signup@example.com']);
  await db.query(`INSERT INTO public.transactions VALUES($1,$2,'credit_purchase','credit_purchase','pending','none',now()-interval '20 days')`, [purchaseId,userId]);
  const jobs = async () => (await db.query('SELECT * FROM public.customer_email_jobs ORDER BY created_at,event_key')).rows;
  assert.equal((await jobs()).length, 0, 'pending purchases never send feedback');
  await db.query(`UPDATE public.transactions SET status='success' WHERE id=$1`, [purchaseId]);
  await db.query(`UPDATE public.transactions SET status='success' WHERE id=$1`, [purchaseId]);
  assert.equal((await jobs()).length, 1, 'duplicate payment verification queues once');
  await db.query('INSERT INTO public.wallets VALUES($1,100)', [userId]);
  await db.query('UPDATE public.wallets SET credits=0 WHERE user_id=$1', [userId]);
  assert.ok((await jobs()).some((job) => job.kind === 'credits_finished'));
  await db.query(`INSERT INTO public.subscriptions VALUES($1,$2,'active',now()-interval '1 day')`, [reviewId,userId]);
  await db.exec('SELECT public.morphly_schedule_customer_emails(14); SELECT public.morphly_schedule_customer_emails(14);');
  let allJobs = await jobs();
  assert.equal(allJobs.filter((job) => job.kind === 'first_purchase_reminder').length, 1);
  assert.equal(allJobs.filter((job) => job.kind === 'subscription_finished').length, 1);
  assert.equal(allJobs.filter((job) => job.kind === 'signup_checkin').length, 0, 'buyers do not get a signup nudge');
  const submitted = await db.query('SELECT public.morphly_submit_review($1,$2,$3,$4,$5) AS id', [userId,reviewId,'issue',2,'The audio stops unexpectedly.']);
  assert.equal(submitted.rows[0].id, reviewId);
  await db.query('SELECT public.morphly_submit_review($1,$2,$3,$4,$5)', [userId,reviewId,'issue',2,'The audio stops unexpectedly.']);
  assert.equal((await jobs()).filter((job) => job.kind === 'admin_review').length, 1);
  assert.equal((await db.query('SELECT email FROM public.customer_reviews')).rows[0].email, 'signup@example.com');
  await assert.rejects(db.query('SELECT public.morphly_submit_review($1,$2,$3,$4,$5)', [userId,reviewId,'idea',2,'Different message but same ID.']), /conflicts/);
  for (let i = 0; i < 4; i++) await db.query('SELECT public.morphly_submit_review($1,gen_random_uuid(),$2,NULL,$3)', [userId,'idea','Please add more background choices.']);
  await assert.rejects(db.query('SELECT public.morphly_submit_review($1,gen_random_uuid(),$2,NULL,$3)', [userId,'idea','A sixth review in the same day.']), /five reviews per day/);
  const claim1 = (await db.query('SELECT * FROM public.morphly_claim_customer_email()')).rows[0];
  const claim2 = (await db.query('SELECT * FROM public.morphly_claim_customer_email()')).rows[0];
  assert.notEqual(claim1.id, claim2.id, 'active leases cannot be claimed twice');
  await db.query(`UPDATE public.customer_email_jobs SET locked_until=now()-interval '1 minute' WHERE id=$1`, [claim1.id]);
  const reclaimed = (await db.query('SELECT * FROM public.morphly_claim_customer_email(NULL,$1)', [claim1.source_id])).rows[0];
  assert.equal(reclaimed.id, claim1.id);
  assert.notEqual(reclaimed.lease_id, claim1.lease_id);
  await db.query(`UPDATE public.customer_email_jobs SET first_attempt_at=now()-interval '25 hours', locked_until=now()-interval '1 minute' WHERE id=$1`, [claim1.id]);
  await db.exec('SELECT * FROM public.morphly_claim_customer_email()');
  assert.equal((await db.query('SELECT status FROM public.customer_email_jobs WHERE id=$1', [claim1.id])).rows[0].status, 'failed');
  const publicAccess = (await db.query(`SELECT has_table_privilege('authenticated','public.customer_reviews','SELECT') AS reviews, has_function_privilege('authenticated','public.morphly_submit_review(uuid,uuid,text,integer,text)','EXECUTE') AS submit`)).rows[0];
  assert.deepEqual(publicAccess, { reviews: false, submit: false });
});
