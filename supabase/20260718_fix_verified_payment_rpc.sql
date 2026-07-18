-- Repairs verified Flutterwave crediting for the production Morphly transaction schema.
-- Safe to run more than once in the Supabase SQL editor.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.apply_verified_package_payment(
  p_user UUID,
  p_package UUID,
  p_reference TEXT,
  p_gateway_id TEXT,
  p_amount NUMERIC,
  p_fee NUMERIC DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg public.credit_packages%ROWTYPE;
  v_old INTEGER;
  v_new INTEGER;
  v_tx UUID;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_reference IS NULL OR length(trim(p_reference)) < 3 OR
     p_gateway_id IS NULL OR length(trim(p_gateway_id)) < 1 OR
     p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid verified payment';
  END IF;

  SELECT * INTO v_pkg
  FROM public.credit_packages
  WHERE id = p_package AND status = 'active' AND is_active = TRUE
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Package is unavailable'; END IF;
  IF p_amount < v_pkg.price_ngn THEN
    RAISE EXCEPTION 'Verified amount is below package price';
  END IF;

  SELECT id INTO v_tx
  FROM public.transactions
  WHERE reference = p_reference
     OR (payment_gateway = 'flutterwave' AND gateway_transaction_id = p_gateway_id)
  LIMIT 1;

  IF v_tx IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'success',
      'duplicate', TRUE,
      'transactionId', v_tx
    );
  END IF;

  INSERT INTO public.wallets(user_id, credits)
  VALUES (p_user, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT credits INTO v_old
  FROM public.wallets
  WHERE user_id = p_user
  FOR UPDATE;
  IF v_old IS NULL THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  v_new := v_old + v_pkg.credits;

  INSERT INTO public.transactions(
    user_id,
    amount,
    type,
    reference,
    status,
    payment_gateway,
    gateway_transaction_id,
    gateway_fee_ngn,
    refund_status,
    package_id,
    package_name_snapshot,
    package_price_snapshot_ngn,
    package_credits_snapshot,
    verified_at
  ) VALUES (
    p_user,
    p_amount,
    'credit_purchase',
    p_reference,
    'success',
    'flutterwave',
    p_gateway_id,
    COALESCE(p_fee, 0),
    'none',
    v_pkg.id,
    v_pkg.name,
    v_pkg.price_ngn,
    v_pkg.credits,
    NOW()
  )
  RETURNING id INTO v_tx;

  UPDATE public.wallets
  SET credits = v_new, updated_at = NOW()
  WHERE user_id = p_user;

  INSERT INTO public.wallet_ledger(
    user_id,
    transaction_id,
    delta,
    balance_after,
    entry_type,
    reason,
    idempotency_key
  ) VALUES (
    p_user,
    v_tx,
    v_pkg.credits,
    v_new,
    'package_purchase',
    'Verified Flutterwave payment',
    'payment:' || p_reference
  );

  RETURN jsonb_build_object(
    'status', 'success',
    'duplicate', FALSE,
    'transactionId', v_tx,
    'creditsAdded', v_pkg.credits,
    'newCredits', v_new
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_verified_package_payment(UUID,UUID,TEXT,TEXT,NUMERIC,NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_verified_package_payment(UUID,UUID,TEXT,TEXT,NUMERIC,NUMERIC)
  TO service_role;
