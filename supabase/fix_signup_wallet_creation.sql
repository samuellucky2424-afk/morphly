-- =============================================================================
-- MORPHLY SIGNUP WALLET CREATION FIX
-- Run this in the Supabase SQL Editor for the Morphly project.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  balance NUMERIC(12, 2) DEFAULT 0,
  credits INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.wallets SET balance = 0 WHERE balance IS NULL OR balance < 0;
UPDATE public.wallets SET credits = 0 WHERE credits IS NULL OR credits < 0;

ALTER TABLE public.wallets ALTER COLUMN balance SET DEFAULT 0;
ALTER TABLE public.wallets ALTER COLUMN credits SET DEFAULT 0;
ALTER TABLE public.wallets ALTER COLUMN currency SET DEFAULT 'USD';

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_user_id_unique ON public.wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallets_balance_non_negative'
      AND conrelid = 'public.wallets'::regclass
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallets_credits_non_negative'
      AND conrelid = 'public.wallets'::regclass
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_credits_non_negative CHECK (credits >= 0);
  END IF;
END $$;

-- Remove old auth signup triggers whose functions still reference a wallet table.
-- This is intentionally broader than only "walletw" because a stale trigger can
-- keep writing to public.wallet, public.walletw, or another previous wallet table
-- even after the app code has been fixed.
DO $$
DECLARE
  trigger_record RECORD;
BEGIN
  FOR trigger_record IN
    SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND NOT t.tgisinternal
      AND pg_get_functiondef(p.oid) ILIKE '%wallet%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users', trigger_record.tgname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email)
  VALUES (NEW.id, COALESCE(NEW.email, ''))
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        updated_at = NOW();

  INSERT INTO public.wallets (user_id, balance, credits)
  VALUES (NEW.id, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_create_wallet ON public.users;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Repair existing Auth users that are missing app profiles or wallets.
INSERT INTO public.users (id, email)
SELECT auth_users.id, COALESCE(auth_users.email, '')
FROM auth.users AS auth_users
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      updated_at = NOW();

INSERT INTO public.wallets (user_id, balance, credits)
SELECT auth_users.id, 0, 0
FROM auth.users AS auth_users
LEFT JOIN public.wallets ON public.wallets.user_id = auth_users.id
WHERE public.wallets.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- If a previous broken trigger created rows in common wrong tables, copy them
-- into public.wallets without deleting any existing data.
DO $$
DECLARE
  wrong_table TEXT;
  balance_expr TEXT;
  credits_expr TEXT;
BEGIN
  FOREACH wrong_table IN ARRAY ARRAY['walletw', 'wallet']
  LOOP
    IF to_regclass(format('public.%I', wrong_table)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = wrong_table
        AND column_name = 'user_id'
    ) THEN
      CONTINUE;
    END IF;

    balance_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = wrong_table
          AND column_name = 'balance'
      )
        THEN 'COALESCE(wrong_wallet.balance, 0)'
      ELSE '0'
    END;

    credits_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = wrong_table
          AND column_name = 'credits'
      )
        THEN 'COALESCE(wrong_wallet.credits, 0)'
      ELSE '0'
    END;

    EXECUTE format(
      $copy_wrong_wallet$
      INSERT INTO public.wallets (user_id, balance, credits)
      SELECT
        wrong_wallet.user_id,
        %s,
        %s
      FROM public.%I AS wrong_wallet
      WHERE wrong_wallet.user_id IS NOT NULL
      ON CONFLICT (user_id) DO NOTHING
      $copy_wrong_wallet$,
      balance_expr,
      credits_expr,
      wrong_table
    );
  END LOOP;
END $$;
