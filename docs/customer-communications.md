# Customer communications

Implemented locally; production activation is still required. No bulk emails have been sent as part of development.

## Activate

1. Apply `supabase/migrations/20260905120000_customer_engagement.sql` to the Supabase database used by the API, after the existing account/payment/admin schema migrations.
2. Set these **server-only** environment variables on the API deployment:
   - `RESEND_API_KEY`: the Resend sending key.
   - `RESEND_FROM_EMAIL`: a sender on a verified Resend domain, for example `Morphly <feedback@morphly.fun>`.
   - `CRON_SECRET`: a long random secret; Vercel supplies it as the cron request's bearer token.
   - `CUSTOMER_REMINDER_DAYS=14`: optional, accepts 1–365 days.
   - `EMAIL_PUBLIC_BASE_URL=https://live.morphly.fun`: the public origin serving the unsubscribe API.
3. Deploy the API, dashboard and private admin portal together. Version 2.5.2 includes the desktop dashboard changes; distribute the installer after the tagged release build succeeds.
4. Test with a designated test account before enabling customer delivery. Review the email job status in **Feedback & notices**. “Sent” means Resend accepted the request, not confirmed inbox delivery.

Never use `VITE_*` for Resend or the cron secret. The local environment did not contain the Resend key, sender or cron secret when this feature was implemented.

## Default behaviour

| Event | Email |
| --- | --- |
| Verified successful credit purchase | Thank-you and experience request, once per transaction |
| Paid wallet crosses from positive credits to zero | Experience request, once per latest non-refunded purchase |
| Subscription expires | Experience request, once per subscription record |
| First successful purchase with no further successful purchase after 14 days | One return/experience reminder per account |
| Confirmed signup at least 7 days ago, without any successful purchase | One experience check-in per account |
| Dashboard review submitted | Review sent to `samuellucky2424@gmail.com` |

Existing eligible accounts can receive the one-time signup/first-purchase check-in when the scheduler is first activated. These are not recurring daily emails. Every template includes `https://live.morphly.fun`; customer replies go to the administrator. Customer emails include an unsubscribe link with a confirmation page, so automated GET link scanners cannot unsubscribe users.

Payment and review handlers attempt their own queued email immediately. Other jobs are drained by `/api/engagement-cron`, scheduled daily at 10:00 UTC in both Vercel configurations. Each run attempts up to 100 jobs with a time budget. The endpoint requires `Authorization: Bearer <CRON_SECRET>` and may also be invoked by a trusted external scheduler; use a 5–15 minute cadence for larger queues and timely retries, or configure a more frequent Vercel schedule if the hosting plan supports it. Daily-only operation can defer expiry emails until the following run.

## Reliability and access

- Database triggers and the review RPC queue emails transactionally. A Resend outage does not erase a review or reverse a successful payment.
- Unique event IDs, leased claims and stable Resend idempotency keys prevent duplicate sends during retries. Retries retain the exact provider request body.
- Failed attempts back off; jobs whose first attempt is over 23 hours old stop for manual investigation, instead of risking a duplicate outside Resend's idempotency window. A daily-only scheduler may leave such failures for investigation; use the shorter cadence above for automatic retries within that window.
- Opt-outs, unconfirmed emails, suspended accounts, refunds, repeat purchases, wallet top-ups and subscription renewal are rechecked before customer delivery.
- All new tables are inaccessible to anonymous and authenticated database clients. APIs verify user tokens; announcement publishing and review management additionally require active admin membership.
- Reviews are private, 10–4,000 characters, optionally rated 1–5, and limited to five per account per rolling day. Recipient email comes from the authenticated account, never a client-supplied address.

## Dashboard and admin

The white review dialog opens once per app renderer launch for each signed-in account, after onboarding and outside active streaming/update operations. It can be dismissed or reopened through **Feedback**. No corner toast is used for these forms.

Both admin interfaces have **Feedback & notices**. Admins can read reviews, update review status, publish an update/maintenance notice, schedule its start/end, or end it early. User dashboards poll every 30 seconds, show a compact top banner, and remember dismissal for the current session. An end time displays an expected-end countdown and automatically hides the notice. Notices inform users; they do not disable engines or guarantee service recovery at the displayed time.

## Verification performed

- 133 Node tests passed, including actual PostgreSQL migration/trigger tests through PGlite, API authorization, suppression, delivery retries and shared light-theme checks.
- TypeScript and production Vite build passed using the valid local public Supabase configuration. `.env.production.local` contains placeholder public configuration and was not changed.
- Isolated browser tests passed for review submission/retry, keyboard close/focus, launch prompting, banner dismissal, narrow-window layout, admin publishing/status updates, and the private admin portal. No production users, payments, microphone or emails were used by these tests.
