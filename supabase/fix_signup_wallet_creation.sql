-- =============================================================================
-- MORPHLY SIGNUP WALLET CREATION FIX
-- Run this in the Supabase SQL Editor for the Morphly project.
--
-- This script only manages Morphly-owned objects:
--   public.users
--   public.wallets
--   public.morphly_handle_new_user()
--   morphly_on_auth_user_created
--
-- It does not copy from, drop, or modify other app tables such as public.wallet
-- or public.walletw.
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

CREATE OR REPLACE FUNCTION public.morphly_handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'app', '') <> 'morphly' THEN
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS morphly_on_auth_user_created ON auth.users;

CREATE TRIGGER morphly_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.morphly_handle_new_user();

-- Repair existing Morphly Auth users that are missing app profiles or wallets.
-- Users from other apps in the same Supabase project are intentionally ignored.
INSERT INTO public.users (id, email)
SELECT auth_users.id, COALESCE(auth_users.email, '')
FROM auth.users AS auth_users
WHERE COALESCE(auth_users.raw_user_meta_data->>'app', '') = 'morphly'
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      updated_at = NOW();

INSERT INTO public.wallets (user_id, balance, credits)
SELECT auth_users.id, 0, 0
FROM auth.users AS auth_users
LEFT JOIN public.wallets ON public.wallets.user_id = auth_users.id
WHERE public.wallets.user_id IS NULL
  AND COALESCE(auth_users.raw_user_meta_data->>'app', '') = 'morphly'
ON CONFLICT (user_id) DO NOTHING;
