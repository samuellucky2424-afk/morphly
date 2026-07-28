-- =============================================================================
-- MORPHLY DECART USAGE AUDIT AND ATOMIC REAL-TIME BILLING
--
-- Apply in the Supabase SQL Editor before deploying the matching API changes.
-- The migration is idempotent and does not alter historical wallet balances.
-- =============================================================================

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'decart',
  ADD COLUMN IF NOT EXISTS provider_model TEXT NOT NULL DEFAULT 'lucy-2.5',
  ADD COLUMN IF NOT EXISTS provider_token_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_max_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS last_usage_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_installation_id TEXT,
  ADD COLUMN IF NOT EXISTS wallet_debited_credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS end_reason TEXT;

UPDATE public.sessions
SET
  provider = COALESCE(NULLIF(provider, ''), 'decart'),
  provider_model = COALESCE(NULLIF(provider_model, ''), 'lucy-2.5'),
  wallet_debited_credits = GREATEST(COALESCE(wallet_debited_credits, 0), 0)
WHERE
  provider IS NULL
  OR provider = ''
  OR provider_model IS NULL
  OR provider_model = ''
  OR wallet_debited_credits IS NULL
  OR wallet_debited_credits < 0;

CREATE INDEX IF NOT EXISTS idx_sessions_user_created_at
  ON public.sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_active_user
  ON public.sessions(user_id, created_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_analytics_events_decart_tokens
  ON public.analytics_events(user_id, created_at DESC)
  WHERE event_name = 'decart_token_issued';

-- Repeat the wallet/session RLS lockdown here so this incident migration is
-- safe even on projects that started from the older FOR ALL policies.
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Admins can update all wallets" ON public.wallets;
DROP POLICY IF EXISTS "Users can view own wallet (join)" ON public.wallets;
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet"
  ON public.wallets
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.wallets FROM anon, authenticated;
GRANT SELECT ON public.wallets TO authenticated;

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can update own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Service role can insert transactions" ON public.transactions;
DROP POLICY IF EXISTS "Admins can insert transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;
CREATE POLICY "Users can view own transactions"
  ON public.transactions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.transactions FROM anon, authenticated;
GRANT SELECT ON public.transactions TO authenticated;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can view own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can insert own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can update own sessions" ON public.sessions;
CREATE POLICY "Users can view own sessions"
  ON public.sessions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.sessions FROM anon, authenticated;
GRANT SELECT ON public.sessions TO authenticated;

-- Record a generation delta and debit the wallet in the same database
-- transaction. One wallet-ledger row is maintained per AI session.
CREATE OR REPLACE FUNCTION public.record_ai_session_usage(
  p_user UUID,
  p_session UUID,
  p_seconds_delta INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
  v_wallet INTEGER;
  v_delta_seconds INTEGER;
  v_provider_limit INTEGER;
  v_total_available_credits INTEGER;
  v_target_seconds INTEGER;
  v_target_credits INTEGER;
  v_credit_delta INTEGER;
  v_balance_after INTEGER;
BEGIN
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  v_delta_seconds := LEAST(GREATEST(COALESCE(p_seconds_delta, 0), 0), 60);
  IF v_delta_seconds <= 0 THEN
    RAISE EXCEPTION 'A positive seconds delta is required';
  END IF;

  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session AND user_id = p_user AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'shouldStop', TRUE,
      'reason', 'session_not_found',
      'remainingCredits', 0
    );
  END IF;

  SELECT credits
  INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user
  FOR UPDATE;

  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  v_provider_limit := LEAST(
    GREATEST(COALESCE(v_session.provider_max_seconds, 7200), 10),
    7200
  );
  v_total_available_credits :=
    GREATEST(v_wallet, 0) + GREATEST(COALESCE(v_session.wallet_debited_credits, 0), 0);
  v_target_seconds := LEAST(
    GREATEST(COALESCE(v_session.seconds_used, 0), 0) + v_delta_seconds,
    FLOOR(v_total_available_credits / 2.0)::INTEGER,
    v_provider_limit
  );
  v_target_credits := v_target_seconds * 2;
  v_credit_delta := GREATEST(
    v_target_credits - GREATEST(COALESCE(v_session.wallet_debited_credits, 0), 0),
    0
  );
  v_credit_delta := LEAST(v_credit_delta, GREATEST(v_wallet, 0));
  v_balance_after := GREATEST(v_wallet - v_credit_delta, 0);

  UPDATE public.wallets
  SET credits = v_balance_after, updated_at = NOW()
  WHERE user_id = p_user;

  UPDATE public.sessions
  SET
    seconds_used = v_target_seconds,
    cost = v_target_credits,
    credits_used = v_target_credits,
    wallet_debited_credits =
      GREATEST(COALESCE(wallet_debited_credits, 0), 0) + v_credit_delta,
    last_usage_at = NOW()
  WHERE id = p_session;

  IF v_target_credits > 0 THEN
    INSERT INTO public.wallet_ledger (
      user_id,
      delta,
      balance_after,
      entry_type,
      reason,
      idempotency_key
    ) VALUES (
      p_user,
      -v_target_credits,
      v_balance_after,
      'ai_session_usage',
      'Decart realtime generation usage',
      'ai-session:' || p_session::TEXT
    )
    ON CONFLICT (idempotency_key) DO UPDATE
    SET
      delta = EXCLUDED.delta,
      balance_after = EXCLUDED.balance_after,
      reason = EXCLUDED.reason;
  END IF;

  RETURN jsonb_build_object(
    'recordedSeconds', v_target_seconds - GREATEST(COALESCE(v_session.seconds_used, 0), 0),
    'totalBillableSeconds', v_target_seconds,
    'creditsDebited', v_credit_delta,
    'totalCreditsUsed', v_target_credits,
    'remainingCredits', v_balance_after,
    'shouldStop', v_balance_after < 2 OR v_target_seconds >= v_provider_limit
  );
END;
$$;

-- Finalize a session, debit any usage that was recorded by an older API build
-- but not yet applied to the wallet, and write the durable ledger entry.
CREATE OR REPLACE FUNCTION public.finalize_ai_session(
  p_user UUID,
  p_session UUID,
  p_final_seconds_delta INTEGER DEFAULT 0,
  p_reason TEXT DEFAULT 'client_ended'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
  v_wallet INTEGER;
  v_provider_limit INTEGER;
  v_total_available_credits INTEGER;
  v_billable_seconds INTEGER;
  v_target_credits INTEGER;
  v_credit_delta INTEGER;
  v_balance_after INTEGER;
BEGIN
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  SELECT *
  INTO v_session
  FROM public.sessions
  WHERE id = p_session AND user_id = p_user
  FOR UPDATE;

  SELECT credits
  INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user
  FOR UPDATE;

  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  IF NOT FOUND OR v_session.id IS NULL THEN
    RETURN jsonb_build_object(
      'duplicate', TRUE,
      'remainingCredits', GREATEST(v_wallet, 0)
    );
  END IF;

  IF v_session.status <> 'active' THEN
    RETURN jsonb_build_object(
      'duplicate', TRUE,
      'sessionId', v_session.id,
      'remainingCredits', GREATEST(v_wallet, 0),
      'creditsUsed', GREATEST(COALESCE(v_session.cost, v_session.credits_used, 0), 0)
    );
  END IF;

  v_provider_limit := LEAST(
    GREATEST(COALESCE(v_session.provider_max_seconds, 7200), 10),
    7200
  );
  v_total_available_credits :=
    GREATEST(v_wallet, 0) + GREATEST(COALESCE(v_session.wallet_debited_credits, 0), 0);
  v_billable_seconds := LEAST(
    GREATEST(COALESCE(v_session.seconds_used, 0), 0)
      + LEAST(GREATEST(COALESCE(p_final_seconds_delta, 0), 0), 7200),
    FLOOR(v_total_available_credits / 2.0)::INTEGER,
    v_provider_limit
  );
  v_target_credits := v_billable_seconds * 2;
  v_credit_delta := GREATEST(
    v_target_credits - GREATEST(COALESCE(v_session.wallet_debited_credits, 0), 0),
    0
  );
  v_credit_delta := LEAST(v_credit_delta, GREATEST(v_wallet, 0));
  v_balance_after := GREATEST(v_wallet - v_credit_delta, 0);

  UPDATE public.wallets
  SET credits = v_balance_after, updated_at = NOW()
  WHERE user_id = p_user;

  UPDATE public.sessions
  SET
    end_time = NOW(),
    status = 'ended',
    seconds_used = v_billable_seconds,
    cost = v_target_credits,
    credits_used = v_target_credits,
    wallet_debited_credits =
      GREATEST(COALESCE(wallet_debited_credits, 0), 0) + v_credit_delta,
    last_usage_at = CASE WHEN v_billable_seconds > 0 THEN NOW() ELSE last_usage_at END,
    end_reason = LEFT(COALESCE(NULLIF(TRIM(p_reason), ''), 'client_ended'), 80)
  WHERE id = p_session;

  IF v_target_credits > 0 THEN
    INSERT INTO public.wallet_ledger (
      user_id,
      delta,
      balance_after,
      entry_type,
      reason,
      idempotency_key
    ) VALUES (
      p_user,
      -v_target_credits,
      v_balance_after,
      'ai_session_usage',
      'Decart realtime generation usage',
      'ai-session:' || p_session::TEXT
    )
    ON CONFLICT (idempotency_key) DO UPDATE
    SET
      delta = EXCLUDED.delta,
      balance_after = EXCLUDED.balance_after,
      reason = EXCLUDED.reason;
  END IF;

  RETURN jsonb_build_object(
    'sessionId', p_session,
    'secondsUsed', v_billable_seconds,
    'creditsUsed', v_target_credits,
    'creditsDebited', v_credit_delta,
    'remainingCredits', v_balance_after,
    'duplicate', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_session_usage(UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_ai_session(UUID, UUID, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_session_usage(UUID, UUID, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_ai_session(UUID, UUID, INTEGER, TEXT)
  TO service_role;
