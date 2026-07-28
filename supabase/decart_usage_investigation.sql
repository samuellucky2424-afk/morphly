-- =============================================================================
-- DECART CREDIT-DRAIN INVESTIGATION
--
-- Run each result set in the Supabase SQL Editor. Change the interval in the
-- params CTE when investigating a different period.
-- =============================================================================

-- 1. Rank users by confirmed Morphly usage and possible untracked exposure.
-- "potential_untracked_seconds" is not a confirmed Decart bill. It is the
-- provider-session-capped wall time after a first frame that has no matching
-- generation seconds in Morphly.
WITH params AS (
  SELECT NOW() - INTERVAL '48 hours' AS since
),
session_usage AS (
  SELECT
    s.id,
    s.user_id,
    s.status,
    s.created_at,
    GREATEST(COALESCE(s.seconds_used, 0), 0)::BIGINT AS recorded_seconds,
    GREATEST(
      COALESCE(s.cost, 0),
      COALESCE(s.credits_used, 0),
      COALESCE(s.seconds_used, 0) * 2
    )::BIGINT AS recorded_credits,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.analytics_events e
      WHERE e.session_id = s.id
        AND e.event_name = 'first_frame_received'
    ) THEN GREATEST(
      LEAST(
        7200,
        EXTRACT(EPOCH FROM (
          COALESCE(s.end_time, NOW()) - COALESCE(s.start_time, s.created_at)
        ))::BIGINT
      ) - GREATEST(COALESCE(s.seconds_used, 0), 0),
      0
    ) ELSE 0 END AS potential_untracked_seconds
  FROM public.sessions s, params p
  WHERE s.created_at >= p.since
),
user_usage AS (
  SELECT
    user_id,
    COUNT(*) AS provider_tokens_estimated,
    COUNT(*) FILTER (WHERE status = 'active') AS active_sessions,
    SUM(recorded_seconds) AS recorded_seconds,
    SUM(recorded_credits) AS recorded_morphly_credits,
    SUM(potential_untracked_seconds) AS potential_untracked_seconds,
    MIN(created_at) AS first_activity,
    MAX(created_at) AS last_activity
  FROM session_usage
  GROUP BY user_id
),
installations AS (
  SELECT
    e.user_id,
    COUNT(DISTINCT e.installation_id) FILTER (WHERE e.installation_id IS NOT NULL) AS installation_count,
    ARRAY_AGG(DISTINCT e.installation_id) FILTER (WHERE e.installation_id IS NOT NULL) AS installation_ids
  FROM public.analytics_events e, params p
  WHERE e.created_at >= p.since
  GROUP BY e.user_id
)
SELECT
  uu.user_id,
  au.email,
  uu.provider_tokens_estimated,
  uu.active_sessions,
  uu.recorded_seconds,
  uu.recorded_morphly_credits,
  uu.potential_untracked_seconds,
  uu.potential_untracked_seconds * 2 AS potential_untracked_morphly_credits,
  w.credits AS wallet_credits_now,
  COALESCE(i.installation_count, 0) AS installations,
  i.installation_ids,
  uu.first_activity,
  uu.last_activity
FROM user_usage uu
LEFT JOIN auth.users au ON au.id = uu.user_id
LEFT JOIN public.wallets w ON w.user_id = uu.user_id
LEFT JOIN installations i ON i.user_id = uu.user_id
ORDER BY recorded_morphly_credits DESC, potential_untracked_seconds DESC;

-- 2. Inspect every suspicious session, including proof that a first frame was
-- received even when zero generation seconds were recorded.
WITH params AS (
  SELECT NOW() - INTERVAL '48 hours' AS since
)
SELECT
  s.id AS session_id,
  au.email,
  s.user_id,
  s.status,
  s.start_time,
  s.end_time,
  ROUND(EXTRACT(EPOCH FROM (
    COALESCE(s.end_time, NOW()) - COALESCE(s.start_time, s.created_at)
  )))::BIGINT AS wall_seconds,
  COALESCE(s.seconds_used, 0) AS recorded_seconds,
  GREATEST(
    COALESCE(s.cost, 0),
    COALESCE(s.credits_used, 0),
    COALESCE(s.seconds_used, 0) * 2
  ) AS recorded_credits,
  EXISTS (
    SELECT 1
    FROM public.analytics_events e
    WHERE e.session_id = s.id
      AND e.event_name = 'first_frame_received'
  ) AS first_frame_received,
  (
    SELECT STRING_AGG(DISTINCT e.installation_id, ', ')
    FROM public.analytics_events e
    WHERE e.session_id = s.id
  ) AS installation_ids
FROM public.sessions s
LEFT JOIN auth.users au ON au.id = s.user_id
WHERE s.created_at >= (SELECT since FROM params)
ORDER BY s.created_at DESC;

-- 3. Show durable server-side Decart token mints after the audit deployment.
SELECT
  e.created_at,
  e.user_id,
  au.email,
  e.session_id,
  e.installation_id,
  e.platform,
  e.metadata->>'model' AS model,
  e.metadata->>'maxSessionSeconds' AS max_session_seconds,
  e.metadata->>'expiresAt' AS token_expires_at,
  e.metadata->>'requestFingerprint' AS request_fingerprint
FROM public.analytics_events e
LEFT JOIN auth.users au ON au.id = e.user_id
WHERE e.event_name = 'decart_token_issued'
ORDER BY e.created_at DESC
LIMIT 500;

-- 4. Find rapid token minting/restarts that may indicate replay or automation.
SELECT
  e.user_id,
  au.email,
  DATE_TRUNC('minute', e.created_at) AS minute,
  COUNT(*) AS tokens_in_minute,
  COUNT(DISTINCT e.installation_id) AS installations,
  COUNT(DISTINCT e.metadata->>'requestFingerprint') AS request_fingerprints
FROM public.analytics_events e
LEFT JOIN auth.users au ON au.id = e.user_id
WHERE e.event_name = 'decart_token_issued'
  AND e.created_at >= NOW() - INTERVAL '7 days'
GROUP BY e.user_id, au.email, DATE_TRUNC('minute', e.created_at)
HAVING COUNT(*) >= 3
ORDER BY tokens_in_minute DESC, minute DESC;

-- 5. Confirm wallet deductions and their final balances after real-time atomic
-- billing is deployed.
SELECT
  wl.created_at,
  wl.user_id,
  au.email,
  wl.delta,
  wl.balance_after,
  wl.entry_type,
  wl.reason,
  wl.idempotency_key
FROM public.wallet_ledger wl
LEFT JOIN auth.users au ON au.id = wl.user_id
WHERE wl.entry_type = 'ai_session_usage'
ORDER BY wl.created_at DESC
LIMIT 500;

-- 6. Active sessions that should be reviewed or closed.
SELECT
  s.id AS session_id,
  s.user_id,
  au.email,
  s.start_time,
  ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(s.start_time, s.created_at))))::BIGINT AS open_seconds,
  COALESCE(s.seconds_used, 0) AS recorded_seconds,
  COALESCE(s.cost, s.credits_used, 0) AS recorded_credits
FROM public.sessions s
LEFT JOIN auth.users au ON au.id = s.user_id
WHERE s.status = 'active'
ORDER BY s.start_time;

-- 7. Find wallet balances that are not supported by purchase, bonus, referral
-- or admin-adjustment records. Large non-admin values are possible evidence of
-- direct wallet updates under an older, permissive RLS policy.
WITH transaction_grants AS (
  SELECT
    user_id,
    SUM(GREATEST(COALESCE(credits, 0), COALESCE(package_credits_snapshot, 0)))::BIGINT AS credits
  FROM public.transactions
  WHERE COALESCE(transaction_type, type, '') NOT IN ('debit', 'usage', 'session_usage')
  GROUP BY user_id
),
ledger_grants AS (
  SELECT
    user_id,
    SUM(delta)::BIGINT AS credits
  FROM public.wallet_ledger
  WHERE delta > 0
  GROUP BY user_id
)
SELECT
  w.user_id,
  au.email,
  w.credits AS wallet_credits_now,
  COALESCE(tg.credits, 0) AS transaction_grants,
  COALESCE(lg.credits, 0) AS ledger_grants,
  GREATEST(
    w.credits - GREATEST(COALESCE(tg.credits, 0), COALESCE(lg.credits, 0)),
    0
  ) AS unexplained_current_credits,
  EXISTS (
    SELECT 1
    FROM public.admin_users admin
    WHERE admin.user_id = w.user_id AND admin.is_active = TRUE
  ) AS is_admin,
  w.created_at,
  w.updated_at
FROM public.wallets w
LEFT JOIN auth.users au ON au.id = w.user_id
LEFT JOIN transaction_grants tg ON tg.user_id = w.user_id
LEFT JOIN ledger_grants lg ON lg.user_id = w.user_id
WHERE w.credits >= 500
ORDER BY unexplained_current_credits DESC;
