-- Adds per-user onboarding, physical-camera-era account bootstrap data,
-- idempotent signup credits, and first-purchase referral rewards.
-- Apply after 20260720_backfill_morphly_user_metadata.sql.
-- Existing accounts receive referral codes and onboarding state, but do not
-- receive the new-account signup credit grant.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS referral_code TEXT,
  ADD COLUMN IF NOT EXISTS referred_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS signup_bonus_welcome_shown_at TIMESTAMPTZ;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS wallet_id UUID REFERENCES public.wallets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amount_naira NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS transaction_type TEXT,
  ADD COLUMN IF NOT EXISTS related_user_id UUID,
  ADD COLUMN IF NOT EXISTS related_payment_id UUID;

-- Production installations may have started from either historical
-- transactions.type convention. Accept every value already used by Morphly's
-- trusted billing and credit flows before the signup trigger writes "credit".
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
    EXECUTE format(
      'ALTER TABLE public.transactions DROP CONSTRAINT %I',
      constraint_record.conname
    );
  END LOOP;

  ALTER TABLE public.transactions
    ADD CONSTRAINT transactions_type_check
    CHECK (
      type IN (
        'credit',
        'debit',
        'credit_purchase',
        'usage',
        'purchase',
        'payment',
        'session_usage'
      )
    )
    NOT VALID;
END;
$$;

-- Some early Morphly schemas required transactions.amount != 0. Monetary
-- amount must be zero for non-purchase credit grants such as signup and
-- referral bonuses, so remove only that historical non-zero check. Verified
-- package payments still enforce a positive amount inside the trusted RPC.
DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass
      AND contype = 'c'
      AND regexp_replace(
        pg_get_expr(conbin, conrelid),
        '[[:space:]]+',
        '',
        'g'
      ) ~* '(^|[^a-z_])amount(<>|!=)\(?0'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.transactions DROP CONSTRAINT %I',
      constraint_record.conname
    );
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_unique
  ON public.transactions(reference)
  WHERE reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_gateway_id_unique
  ON public.transactions(payment_gateway, gateway_transaction_id)
  WHERE gateway_transaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.morphly_generate_referral_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes BYTEA;
  v_candidate TEXT;
  v_index INTEGER;
BEGIN
  LOOP
    v_bytes := extensions.gen_random_bytes(8);
    v_candidate := '';

    FOR v_index IN 0..7 LOOP
      v_candidate := v_candidate
        || substr(v_alphabet, (get_byte(v_bytes, v_index) % length(v_alphabet)) + 1, 1);
    END LOOP;

    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM public.users
      WHERE referral_code = v_candidate
    );
  END LOOP;

  RETURN v_candidate;
END;
$$;

DO $$
DECLARE
  v_user_id UUID;
BEGIN
  FOR v_user_id IN
    SELECT id
    FROM public.users
    WHERE referral_code IS NULL OR referral_code = ''
    ORDER BY created_at, id
  LOOP
    UPDATE public.users
    SET referral_code = public.morphly_generate_referral_code()
    WHERE id = v_user_id
      AND (referral_code IS NULL OR referral_code = '');
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique
  ON public.users(referral_code)
  WHERE referral_code IS NOT NULL;

ALTER TABLE public.users
  ALTER COLUMN referral_code
  SET DEFAULT public.morphly_generate_referral_code();

ALTER TABLE public.users
  ALTER COLUMN referral_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_referral_code_format_check'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_referral_code_format_check
      CHECK (referral_code ~ '^[A-HJ-NP-Z2-9]{6,12}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_onboarding_version_check'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_onboarding_version_check
      CHECK (onboarding_version >= 1) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_referred_by_user_id_fkey'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_referred_by_user_id_fkey
      FOREIGN KEY (referred_by_user_id)
      REFERENCES public.users(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  referred_user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  referral_code_used TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  qualified_purchase_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  reward_transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  qualified_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  disqualified_at TIMESTAMPTZ,
  disqualification_reason TEXT,
  refund_warning BOOLEAN NOT NULL DEFAULT FALSE,
  suspicious BOOLEAN NOT NULL DEFAULT FALSE,
  suspicious_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.referral_validation_attempts (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  request_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.referral_audit_logs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  action TEXT NOT NULL,
  referral_id UUID REFERENCES public.referrals(id) ON DELETE SET NULL,
  referrer_user_id UUID,
  referred_user_id UUID,
  actor_user_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'referrals_status_check'
      AND conrelid = 'public.referrals'::regclass
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_status_check
      CHECK (status IN ('registered', 'qualified', 'rewarded', 'disqualified'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS referrals_referrer_user_id_idx
  ON public.referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS referrals_status_idx
  ON public.referrals(status);
CREATE INDEX IF NOT EXISTS referrals_created_at_idx
  ON public.referrals(created_at DESC);
CREATE INDEX IF NOT EXISTS referral_validation_request_time_idx
  ON public.referral_validation_attempts(request_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS referral_audit_created_at_idx
  ON public.referral_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_transaction_type_idx
  ON public.transactions(transaction_type);

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_validation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own referrals" ON public.referrals;
CREATE POLICY "Users can read own referrals"
  ON public.referrals
  FOR SELECT
  USING (auth.uid() = referrer_user_id OR auth.uid() = referred_user_id);

DROP POLICY IF EXISTS "Admins can read referrals" ON public.referrals;
CREATE POLICY "Admins can read referrals"
  ON public.referrals
  FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins can read referral audit logs" ON public.referral_audit_logs;
CREATE POLICY "Admins can read referral audit logs"
  ON public.referral_audit_logs
  FOR SELECT
  USING (public.is_admin());

-- Wallet and ledger writes are trusted-backend operations only. Preserve
-- existing owner reads and admin reads while removing historical client writes.
DROP POLICY IF EXISTS "Users can view own wallet (join)" ON public.wallets;
DROP POLICY IF EXISTS "Users can only access their own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Admins can update all wallets" ON public.wallets;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can update own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can only access their own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Service role can insert transactions" ON public.transactions;
DROP POLICY IF EXISTS "Admins can insert transactions" ON public.transactions;

DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet"
  ON public.wallets
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;
CREATE POLICY "Users can view own transactions"
  ON public.transactions
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.morphly_protect_user_account_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (
    NEW.referral_code IS DISTINCT FROM OLD.referral_code
    OR NEW.referred_by_user_id IS DISTINCT FROM OLD.referred_by_user_id
    OR NEW.account_status IS DISTINCT FROM OLD.account_status
    OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
    OR NEW.signup_bonus_welcome_shown_at IS DISTINCT FROM OLD.signup_bonus_welcome_shown_at
  ) AND COALESCE(auth.role(), '') <> 'service_role'
    AND current_user NOT IN ('postgres', 'supabase_admin')
  THEN
    RAISE EXCEPTION 'Referral relationship is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS morphly_protect_user_account_fields_trigger ON public.users;
CREATE TRIGGER morphly_protect_user_account_fields_trigger
  BEFORE UPDATE OF
    referral_code,
    referred_by_user_id,
    account_status,
    suspended_at,
    signup_bonus_welcome_shown_at
  ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.morphly_protect_user_account_fields();

CREATE OR REPLACE FUNCTION public.morphly_handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested_referral_code TEXT;
  v_referrer_user_id UUID;
  v_referral_id UUID;
  v_wallet_id UUID;
  v_signup_transaction_id UUID;
  v_balance_after INTEGER;
  v_recent_referral_count INTEGER := 0;
  v_suspicious BOOLEAN := FALSE;
  v_suspicious_reason TEXT;
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'app', '') <> 'morphly' THEN
    RETURN NEW;
  END IF;

  v_requested_referral_code := upper(trim(COALESCE(
    NEW.raw_user_meta_data->>'referral_code',
    ''
  )));

  IF v_requested_referral_code <> '' THEN
    IF v_requested_referral_code !~ '^[A-HJ-NP-Z2-9]{6,12}$' THEN
      RAISE EXCEPTION 'INVALID_REFERRAL_CODE';
    END IF;

    SELECT id
    INTO v_referrer_user_id
    FROM public.users
    WHERE referral_code = v_requested_referral_code
      AND account_status = 'active'
    FOR SHARE;

    IF v_referrer_user_id IS NULL OR v_referrer_user_id = NEW.id THEN
      RAISE EXCEPTION 'INVALID_REFERRAL_CODE';
    END IF;
  END IF;

  INSERT INTO public.users (
    id,
    email,
    referral_code,
    referred_by_user_id,
    onboarding_completed,
    onboarding_version
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    public.morphly_generate_referral_code(),
    v_referrer_user_id,
    FALSE,
    1
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        updated_at = NOW();

  UPDATE public.users
  SET referral_code = public.morphly_generate_referral_code()
  WHERE id = NEW.id
    AND (referral_code IS NULL OR referral_code = '');

  INSERT INTO public.wallets (user_id, balance, credits)
  VALUES (NEW.id, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id, COALESCE(credits, 0)
  INTO v_wallet_id, v_balance_after
  FROM public.wallets
  WHERE user_id = NEW.id
  FOR UPDATE;

  INSERT INTO public.transactions (
    user_id,
    wallet_id,
    type,
    transaction_type,
    amount,
    amount_naira,
    credits,
    reference,
    description,
    status,
    verified_at
  )
  VALUES (
    NEW.id,
    v_wallet_id,
    'credit',
    'signup_bonus',
    0,
    0,
    50,
    'signup_bonus:' || NEW.id::text,
    'New account testing credits',
    'success',
    NOW()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_signup_transaction_id;

  IF v_signup_transaction_id IS NOT NULL THEN
    v_balance_after := v_balance_after + 50;

    UPDATE public.wallets
    SET credits = v_balance_after,
        updated_at = NOW()
    WHERE user_id = NEW.id;

    INSERT INTO public.wallet_ledger (
      user_id,
      transaction_id,
      delta,
      balance_after,
      entry_type,
      reason,
      idempotency_key
    )
    VALUES (
      NEW.id,
      v_signup_transaction_id,
      50,
      v_balance_after,
      'signup_bonus',
      'New account testing credits',
      'signup_bonus:' || NEW.id::text
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    INSERT INTO public.referral_audit_logs (
      action,
      referred_user_id,
      metadata
    )
    VALUES (
      'signup_bonus.granted',
      NEW.id,
      jsonb_build_object(
        'credits', 50,
        'transactionId', v_signup_transaction_id
      )
    );
  END IF;

  IF v_referrer_user_id IS NOT NULL THEN
    SELECT count(*)
    INTO v_recent_referral_count
    FROM public.referrals
    WHERE referrer_user_id = v_referrer_user_id
      AND created_at >= NOW() - INTERVAL '1 hour';

    IF v_recent_referral_count >= 9 THEN
      v_suspicious := TRUE;
      v_suspicious_reason := 'High referral registration velocity: 10 or more signups within one hour';
    END IF;

    INSERT INTO public.referrals (
      referrer_user_id,
      referred_user_id,
      referral_code_used,
      status,
      suspicious,
      suspicious_reason
    )
    VALUES (
      v_referrer_user_id,
      NEW.id,
      v_requested_referral_code,
      'registered',
      v_suspicious,
      v_suspicious_reason
    )
    ON CONFLICT (referred_user_id) DO NOTHING
    RETURNING id INTO v_referral_id;

    IF v_referral_id IS NOT NULL THEN
      INSERT INTO public.referral_audit_logs (
        action,
        referral_id,
        referrer_user_id,
        referred_user_id,
        metadata
      )
      VALUES (
        'referral.attached',
        v_referral_id,
        v_referrer_user_id,
        NEW.id,
        jsonb_build_object('code', v_requested_referral_code)
      );

      IF v_suspicious THEN
        INSERT INTO public.referral_audit_logs (
          action,
          referral_id,
          referrer_user_id,
          referred_user_id,
          metadata
        )
        VALUES (
          'referral.suspicious_velocity_detected',
          v_referral_id,
          v_referrer_user_id,
          NEW.id,
          jsonb_build_object(
            'recentReferralCount', v_recent_referral_count + 1,
            'window', '1 hour',
            'blocked', FALSE
          )
        );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS morphly_on_auth_user_created ON auth.users;
CREATE TRIGGER morphly_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.morphly_handle_new_user();

CREATE OR REPLACE FUNCTION public.morphly_validate_referral_code(
  p_code TEXT,
  p_request_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT := upper(trim(COALESCE(p_code, '')));
  v_request_hash TEXT := left(trim(COALESCE(p_request_hash, '')), 128);
  v_attempt_count INTEGER;
  v_valid BOOLEAN := FALSE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF v_request_hash = '' THEN
    RAISE EXCEPTION 'Request identity required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('referral-validation:' || v_request_hash));

  SELECT count(*)
  INTO v_attempt_count
  FROM public.referral_validation_attempts
  WHERE request_hash = v_request_hash
    AND created_at >= NOW() - INTERVAL '10 minutes';

  IF v_attempt_count >= 20 THEN
    INSERT INTO public.referral_validation_attempts (
      request_hash,
      code_hash,
      allowed
    )
    VALUES (
      v_request_hash,
      encode(extensions.digest(v_code, 'sha256'), 'hex'),
      FALSE
    );

    INSERT INTO public.referral_audit_logs (action, metadata)
    VALUES (
      'referral.validation_rate_limited',
      jsonb_build_object('requestHash', v_request_hash, 'attempts', v_attempt_count + 1)
    );

    RETURN jsonb_build_object('valid', FALSE, 'rateLimited', TRUE);
  END IF;

  IF v_code ~ '^[A-HJ-NP-Z2-9]{6,12}$' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.users
      WHERE referral_code = v_code
        AND account_status = 'active'
    )
    INTO v_valid;
  END IF;

  INSERT INTO public.referral_validation_attempts (
    request_hash,
    code_hash,
    allowed
  )
  VALUES (
    v_request_hash,
    encode(extensions.digest(v_code, 'sha256'), 'hex'),
    v_valid
  );

  DELETE FROM public.referral_validation_attempts
  WHERE created_at < NOW() - INTERVAL '7 days';

  RETURN jsonb_build_object('valid', v_valid, 'rateLimited', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.morphly_claim_signup_bonus_welcome(p_user UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed_count INTEGER := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  UPDATE public.users AS profile
  SET signup_bonus_welcome_shown_at = NOW(),
      updated_at = NOW()
  WHERE profile.id = p_user
    AND profile.signup_bonus_welcome_shown_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.transactions AS transaction
      WHERE transaction.user_id = p_user
        AND transaction.transaction_type = 'signup_bonus'
        AND transaction.reference = 'signup_bonus:' || p_user::text
        AND transaction.status = 'success'
    );

  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;
  RETURN v_claimed_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.morphly_ensure_user_referral_code(p_user UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  UPDATE public.users
  SET referral_code = public.morphly_generate_referral_code(),
      updated_at = NOW()
  WHERE id = p_user
    AND (referral_code IS NULL OR referral_code = '');

  SELECT referral_code
  INTO v_code
  FROM public.users
  WHERE id = p_user;

  RETURN v_code;
END;
$$;

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
  v_is_first_purchase BOOLEAN;
  v_referral public.referrals%ROWTYPE;
  v_referrer_status TEXT;
  v_referrer_old INTEGER;
  v_referrer_new INTEGER;
  v_reward_tx UUID;
  v_referral_rewarded BOOLEAN := FALSE;
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

    SELECT COALESCE(credits, 0)
    INTO v_new
    FROM public.wallets
    WHERE user_id = p_user;

    RETURN jsonb_build_object(
      'status', 'success',
      'duplicate', TRUE,
      'transactionId', v_tx,
      'creditsAdded', COALESCE(v_existing_credits, 0),
      'newCredits', COALESCE(v_new, 0),
      'referralRewarded', FALSE
    );
  END IF;

  SELECT *
  INTO v_pkg
  FROM public.credit_packages
  WHERE id = p_package
    AND status = 'active'
    AND is_active = TRUE
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Package is unavailable';
  END IF;

  IF p_amount < v_pkg.price_ngn THEN
    RAISE EXCEPTION 'Verified amount is below package price';
  END IF;

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
    SELECT 1
    FROM public.users
    WHERE id = p_user
      AND account_status = 'suspended'
  ) THEN
    RAISE EXCEPTION 'Account suspended';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.transactions AS prior_purchase
    WHERE prior_purchase.user_id = p_user
      AND (
        prior_purchase.transaction_type = 'credit_purchase'
        OR prior_purchase.type IN ('credit_purchase', 'purchase', 'payment')
      )
      AND prior_purchase.package_id IS NOT NULL
      AND COALESCE(prior_purchase.amount_naira, prior_purchase.amount, 0) > 0
      AND lower(COALESCE(prior_purchase.status, 'success'))
        IN ('success', 'successful', 'succeeded', 'completed', 'paid', 'verified')
  )
  INTO v_is_first_purchase;

  INSERT INTO public.wallets (user_id, balance, credits)
  VALUES (p_user, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT COALESCE(credits, 0)
  INTO v_old
  FROM public.wallets
  WHERE user_id = p_user
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  v_new := v_old + v_pkg.credits;

  INSERT INTO public.transactions (
    user_id,
    amount,
    amount_naira,
    credits,
    type,
    transaction_type,
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
  )
  VALUES (
    p_user,
    p_amount,
    p_amount,
    v_pkg.credits,
    'credit_purchase',
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
  SET credits = v_new,
      updated_at = NOW()
  WHERE user_id = p_user;

  INSERT INTO public.wallet_ledger (
    user_id,
    transaction_id,
    delta,
    balance_after,
    entry_type,
    reason,
    idempotency_key
  )
  VALUES (
    p_user,
    v_tx,
    v_pkg.credits,
    v_new,
    'package_purchase',
    'Verified Flutterwave payment',
    'payment:' || p_reference
  );

  IF v_is_first_purchase THEN
    SELECT *
    INTO v_referral
    FROM public.referrals
    WHERE referred_user_id = p_user
    FOR UPDATE;

    IF FOUND AND v_referral.status IN ('registered', 'qualified') THEN
      UPDATE public.referrals
      SET status = 'qualified',
          qualified_purchase_id = v_tx,
          qualified_at = COALESCE(qualified_at, NOW()),
          updated_at = NOW()
      WHERE id = v_referral.id;

      INSERT INTO public.referral_audit_logs (
        action,
        referral_id,
        referrer_user_id,
        referred_user_id,
        metadata
      )
      VALUES (
        'referral.qualified',
        v_referral.id,
        v_referral.referrer_user_id,
        p_user,
        jsonb_build_object('purchaseId', v_tx)
      );

      SELECT account_status
      INTO v_referrer_status
      FROM public.users
      WHERE id = v_referral.referrer_user_id
      FOR SHARE;

      IF v_referral.referrer_user_id IS NULL
        OR v_referral.referrer_user_id = p_user
        OR v_referrer_status IS DISTINCT FROM 'active'
      THEN
        UPDATE public.referrals
        SET status = 'disqualified',
            disqualified_at = NOW(),
            disqualification_reason = 'Referrer is unavailable or ineligible',
            updated_at = NOW()
        WHERE id = v_referral.id;

        INSERT INTO public.referral_audit_logs (
          action,
          referral_id,
          referrer_user_id,
          referred_user_id,
          metadata
        )
        VALUES (
          'referral.disqualified',
          v_referral.id,
          v_referral.referrer_user_id,
          p_user,
          jsonb_build_object('reason', 'Referrer is unavailable or ineligible')
        );
      ELSE
        INSERT INTO public.wallets (user_id, balance, credits)
        VALUES (v_referral.referrer_user_id, 0, 0)
        ON CONFLICT (user_id) DO NOTHING;

        SELECT COALESCE(credits, 0)
        INTO v_referrer_old
        FROM public.wallets
        WHERE user_id = v_referral.referrer_user_id
        FOR UPDATE;

        INSERT INTO public.transactions (
          user_id,
          type,
          transaction_type,
          amount,
          amount_naira,
          credits,
          reference,
          related_user_id,
          related_payment_id,
          description,
          status,
          verified_at
        )
        VALUES (
          v_referral.referrer_user_id,
          'credit',
          'referral_reward',
          0,
          0,
          200,
          'referral_reward:' || p_user::text,
          p_user,
          v_tx,
          'Referral reward for referred user''s first purchase',
          'success',
          NOW()
        )
        ON CONFLICT DO NOTHING
        RETURNING id INTO v_reward_tx;

        IF v_reward_tx IS NOT NULL THEN
          v_referrer_new := v_referrer_old + 200;

          UPDATE public.wallets
          SET credits = v_referrer_new,
              updated_at = NOW()
          WHERE user_id = v_referral.referrer_user_id;

          INSERT INTO public.wallet_ledger (
            user_id,
            transaction_id,
            delta,
            balance_after,
            entry_type,
            reason,
            idempotency_key,
            actor_user_id
          )
          VALUES (
            v_referral.referrer_user_id,
            v_reward_tx,
            200,
            v_referrer_new,
            'referral_reward',
            'Referral reward for referred user''s first purchase',
            'referral_reward:' || p_user::text,
            p_user
          )
          ON CONFLICT (idempotency_key) DO NOTHING;

          UPDATE public.referrals
          SET status = 'rewarded',
              reward_transaction_id = v_reward_tx,
              rewarded_at = NOW(),
              updated_at = NOW()
          WHERE id = v_referral.id;

          INSERT INTO public.referral_audit_logs (
            action,
            referral_id,
            referrer_user_id,
            referred_user_id,
            metadata
          )
          VALUES (
            'referral.reward_granted',
            v_referral.id,
            v_referral.referrer_user_id,
            p_user,
            jsonb_build_object(
              'credits', 200,
              'purchaseId', v_tx,
              'rewardTransactionId', v_reward_tx
            )
          );

          v_referral_rewarded := TRUE;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', 'success',
    'duplicate', FALSE,
    'transactionId', v_tx,
    'creditsAdded', v_pkg.credits,
    'newCredits', v_new,
    'referralRewarded', v_referral_rewarded
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.morphly_flag_referral_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referral_id UUID;
  v_referrer_user_id UUID;
  v_referred_user_id UUID;
BEGIN
  IF COALESCE(NEW.refund_status, 'none') <> 'none'
    AND COALESCE(OLD.refund_status, 'none') = 'none'
  THEN
    UPDATE public.referrals
    SET refund_warning = TRUE,
        updated_at = NOW()
    WHERE qualified_purchase_id = NEW.id
    RETURNING id, referrer_user_id, referred_user_id
    INTO v_referral_id, v_referrer_user_id, v_referred_user_id;

    IF v_referral_id IS NOT NULL THEN
      INSERT INTO public.referral_audit_logs (
        action,
        referral_id,
        referrer_user_id,
        referred_user_id,
        metadata
      )
      VALUES (
        'referral.qualifying_purchase_refunded',
        v_referral_id,
        v_referrer_user_id,
        v_referred_user_id,
        jsonb_build_object(
          'purchaseId', NEW.id,
          'refundStatus', NEW.refund_status,
          'rewardAutomaticallyReversed', FALSE
        )
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_disqualify_referral(
  p_admin UUID,
  p_referral UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referral public.referrals%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE user_id = p_admin
      AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A disqualification reason is required';
  END IF;

  SELECT *
  INTO v_referral
  FROM public.referrals
  WHERE id = p_referral
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral not found';
  END IF;

  IF v_referral.status = 'rewarded' THEN
    RAISE EXCEPTION 'A rewarded referral cannot be disqualified without a supported reversal';
  END IF;

  UPDATE public.referrals
  SET status = 'disqualified',
      disqualified_at = NOW(),
      disqualification_reason = trim(p_reason),
      updated_at = NOW()
  WHERE id = p_referral;

  INSERT INTO public.referral_audit_logs (
    action,
    referral_id,
    referrer_user_id,
    referred_user_id,
    actor_user_id,
    metadata
  )
  VALUES (
    'referral.manually_disqualified',
    v_referral.id,
    v_referral.referrer_user_id,
    v_referral.referred_user_id,
    p_admin,
    jsonb_build_object('reason', trim(p_reason))
  );

  INSERT INTO public.admin_audit_logs (
    admin_user_id,
    action,
    target_type,
    target_id,
    reason,
    before_data,
    after_data
  )
  VALUES (
    p_admin,
    'referral.manually_disqualified',
    'referral',
    p_referral::text,
    trim(p_reason),
    jsonb_build_object('status', v_referral.status),
    jsonb_build_object('status', 'disqualified')
  );

  RETURN jsonb_build_object(
    'id', p_referral,
    'status', 'disqualified',
    'reason', trim(p_reason)
  );
END;
$$;

DROP TRIGGER IF EXISTS morphly_flag_referral_refund_trigger ON public.transactions;
CREATE TRIGGER morphly_flag_referral_refund_trigger
  AFTER UPDATE OF refund_status ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.morphly_flag_referral_refund();

REVOKE ALL ON FUNCTION public.morphly_generate_referral_code() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.morphly_validate_referral_code(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.morphly_claim_signup_bonus_welcome(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.morphly_ensure_user_referral_code(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_verified_package_payment(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_disqualify_referral(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.morphly_generate_referral_code() TO service_role;
GRANT EXECUTE ON FUNCTION public.morphly_validate_referral_code(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.morphly_claim_signup_bonus_welcome(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.morphly_ensure_user_referral_code(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_verified_package_payment(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_disqualify_referral(UUID, UUID, TEXT)
  TO service_role;

COMMIT;
