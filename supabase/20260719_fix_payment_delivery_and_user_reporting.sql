-- Fixes payment delivery and backfills Morphly-owned user/wallet records.
-- Run this file in the production Supabase SQL Editor before deploying the app changes.
-- Safe to run more than once.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.credit_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL CHECK (credits > 0),
  price_ngn NUMERIC(12,2) NOT NULL CHECK (price_ngn >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.credit_packages
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_recommended BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_credit_packages_active
  ON public.credit_packages(is_active);
CREATE INDEX IF NOT EXISTS idx_credit_packages_sort_order
  ON public.credit_packages(sort_order);

INSERT INTO public.credit_packages (name, description, credits, price_ngn, is_active, status, sort_order)
SELECT seed.name, '', seed.credits, seed.price_ngn, TRUE, 'active', seed.sort_order
FROM (
  VALUES
    ('Starter', 500, 11500::NUMERIC, 1),
    ('Basic', 1000, 23000::NUMERIC, 2),
    ('Pro', 2000, 46000::NUMERIC, 3),
    ('Enterprise', 5000, 115000::NUMERIC, 4)
) AS seed(name, credits, price_ngn, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.credit_packages AS existing
  WHERE lower(existing.name) = lower(seed.name)
);

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE public.wallets
SET balance = COALESCE(balance, 0),
    credits = COALESCE(credits, 0),
    updated_at = COALESCE(updated_at, NOW())
WHERE balance IS NULL OR credits IS NULL OR updated_at IS NULL;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_naira NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_gateway TEXT,
  ADD COLUMN IF NOT EXISTS gateway_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS gateway_fee_ngn NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS package_id UUID REFERENCES public.credit_packages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS package_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS package_price_snapshot_ngn NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS package_credits_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Older Morphly schemas only allowed credit/debit while newer schemas used
-- credit_purchase/usage. Accept both so verified purchases cannot be rejected
-- by whichever historical constraint production started with.
DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass
      AND contype = 'c'
      AND pg_get_expr(conbin, conrelid) ~* '(^|[^a-z_])type([^a-z_]|$)'
  LOOP
    EXECUTE format('ALTER TABLE public.transactions DROP CONSTRAINT %I', constraint_record.conname);
  END LOOP;

  ALTER TABLE public.transactions
    ADD CONSTRAINT transactions_type_check
    CHECK (type IN ('credit', 'debit', 'credit_purchase', 'usage', 'purchase', 'payment', 'session_usage'))
    NOT VALID;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_user_id_unique
  ON public.wallets(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_unique
  ON public.transactions(reference) WHERE reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_gateway_id_unique
  ON public.transactions(payment_gateway, gateway_transaction_id)
  WHERE gateway_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.wallet_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  entry_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill tagged accounts and wallets that were missed by an older signup
-- trigger. Existing public.users records are also treated as Morphly-owned.
INSERT INTO public.users (id, email)
SELECT auth_user.id, COALESCE(auth_user.email, '')
FROM auth.users AS auth_user
WHERE COALESCE(auth_user.raw_user_meta_data->>'app', '') = 'morphly'
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      updated_at = NOW();

INSERT INTO public.wallets (user_id, balance, credits)
SELECT profile.id, 0, 0
FROM public.users AS profile
LEFT JOIN public.wallets AS wallet ON wallet.user_id = profile.id
WHERE wallet.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;

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
  v_existing_user UUID;
  v_existing_package UUID;
  v_existing_credits INTEGER;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_user IS NULL OR p_package IS NULL OR
     p_reference IS NULL OR length(trim(p_reference)) < 3 OR
     p_gateway_id IS NULL OR length(trim(p_gateway_id)) < 1 OR
     p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid verified payment';
  END IF;

  -- Serialize the browser callback and webhook for the same reference.
  PERFORM pg_advisory_xact_lock(hashtext('morphly-payment:' || trim(p_reference)));

  SELECT id, user_id, package_id, COALESCE(package_credits_snapshot, credits, 0)
  INTO v_tx, v_existing_user, v_existing_package, v_existing_credits
  FROM public.transactions
  WHERE reference = p_reference
     OR (payment_gateway = 'flutterwave' AND gateway_transaction_id = p_gateway_id)
  LIMIT 1;

  IF v_tx IS NOT NULL THEN
    IF v_existing_user IS DISTINCT FROM p_user THEN
      RAISE EXCEPTION 'Payment user mismatch';
    END IF;
    IF v_existing_package IS NOT NULL AND v_existing_package IS DISTINCT FROM p_package THEN
      RAISE EXCEPTION 'Payment package mismatch';
    END IF;

    SELECT COALESCE(credits, 0) INTO v_new
    FROM public.wallets
    WHERE user_id = p_user;

    RETURN jsonb_build_object(
      'status', 'success',
      'duplicate', TRUE,
      'transactionId', v_tx,
      'creditsAdded', COALESCE(v_existing_credits, 0),
      'newCredits', COALESCE(v_new, 0)
    );
  END IF;

  SELECT * INTO v_pkg
  FROM public.credit_packages
  WHERE id = p_package AND status = 'active' AND is_active = TRUE
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Package is unavailable'; END IF;
  IF p_amount < v_pkg.price_ngn THEN
    RAISE EXCEPTION 'Verified amount is below package price';
  END IF;

  -- Recover safely if the Auth account predates the Morphly profile trigger.
  INSERT INTO public.users (id, email)
  SELECT auth_user.id, COALESCE(auth_user.email, '')
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        updated_at = NOW();

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user) THEN
    RAISE EXCEPTION 'Payment user not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user AND account_status = 'suspended'
  ) THEN
    RAISE EXCEPTION 'Account suspended';
  END IF;

  INSERT INTO public.wallets(user_id, balance, credits)
  VALUES (p_user, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT COALESCE(credits, 0) INTO v_old
  FROM public.wallets
  WHERE user_id = p_user
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  v_new := v_old + v_pkg.credits;

  INSERT INTO public.transactions(
    user_id,
    amount,
    amount_naira,
    credits,
    type,
    reference,
    description,
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
    p_amount,
    v_pkg.credits,
    'credit_purchase',
    p_reference,
    v_pkg.name || ' purchased',
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

COMMIT;
