-- Allow administrators to add or deduct wallet credits through one audited,
-- idempotent adjustment function. A deduction may never overdraw a wallet.
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_admin UUID,
  p_user UUID,
  p_amount INTEGER,
  p_reason TEXT,
  p_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old INTEGER;
  v_new INTEGER;
  v_admin_role TEXT;
  v_existing public.wallet_ledger%ROWTYPE;
BEGIN
  SELECT role
  INTO v_admin_role
    FROM public.admin_users
    WHERE user_id = p_admin
      AND is_active = TRUE
    LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF p_amount IS NULL OR p_amount = 0 OR p_amount < -1000000 OR p_amount > 1000000 THEN
    RAISE EXCEPTION 'Adjustment must be a non-zero integer between -1000000 and 1000000';
  END IF;

  IF p_amount < 0 AND lower(COALESCE(v_admin_role, '')) <> 'super_admin' THEN
    RAISE EXCEPTION 'Super admin access is required to remove credits';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(trim(p_reason)) > 240 THEN
    RAISE EXCEPTION 'A reason between 3 and 240 characters is required';
  END IF;

  IF p_key IS NULL OR length(trim(p_key)) < 8 OR length(trim(p_key)) > 200 THEN
    RAISE EXCEPTION 'A valid idempotency key is required';
  END IF;

  -- Serialize retries that use the same key so concurrent submissions cannot
  -- apply the adjustment twice before the unique ledger insert is visible.
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_key), 0));

  SELECT *
  INTO v_existing
  FROM public.wallet_ledger
  WHERE idempotency_key = trim(p_key);

  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user
      OR v_existing.actor_user_id IS DISTINCT FROM p_admin
      OR v_existing.delta IS DISTINCT FROM p_amount
      OR v_existing.reason IS DISTINCT FROM trim(p_reason)
    THEN
      RAISE EXCEPTION 'Idempotency key was already used for a different adjustment';
    END IF;

    SELECT credits
    INTO v_new
    FROM public.wallets
    WHERE user_id = p_user;
    v_new := COALESCE(v_new, v_existing.balance_after);

    RETURN jsonb_build_object(
      'userId', v_existing.user_id,
      'adjustment', v_existing.delta,
      'creditsAdded', greatest(v_existing.delta, 0),
      'creditsDeducted', greatest(-v_existing.delta, 0),
      'newCredits', v_new,
      'duplicate', TRUE
    );
  END IF;

  SELECT credits
  INTO v_old
  FROM public.wallets
  WHERE user_id = p_user
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  v_old := COALESCE(v_old, 0);
  v_new := v_old + p_amount;

  IF v_new < 0 THEN
    RAISE EXCEPTION 'Cannot deduct % credits; wallet only has % credits', -p_amount, v_old;
  END IF;

  UPDATE public.wallets
  SET credits = v_new,
      updated_at = NOW()
  WHERE user_id = p_user;

  INSERT INTO public.wallet_ledger (
    user_id,
    delta,
    balance_after,
    entry_type,
    reason,
    idempotency_key,
    actor_user_id
  ) VALUES (
    p_user,
    p_amount,
    v_new,
    'admin_adjustment',
    trim(p_reason),
    trim(p_key),
    p_admin
  );

  INSERT INTO public.admin_audit_logs (
    admin_user_id,
    action,
    target_type,
    target_id,
    reason,
    before_data,
    after_data
  ) VALUES (
    p_admin,
    CASE WHEN p_amount > 0 THEN 'credits.added' ELSE 'credits.deducted' END,
    'user',
    p_user::TEXT,
    trim(p_reason),
    jsonb_build_object('credits', v_old),
    jsonb_build_object('credits', v_new, 'adjustment', p_amount)
  );

  RETURN jsonb_build_object(
    'userId', p_user,
    'adjustment', p_amount,
    'creditsAdded', greatest(p_amount, 0),
    'creditsDeducted', greatest(-p_amount, 0),
    'newCredits', v_new,
    'duplicate', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_credits(UUID, UUID, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(UUID, UUID, INTEGER, TEXT, TEXT)
  TO service_role;

CREATE INDEX IF NOT EXISTS idx_admin_audit_target_created
  ON public.admin_audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_created
  ON public.wallet_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON public.transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_created
  ON public.analytics_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created
  ON public.analytics_events(created_at DESC);
