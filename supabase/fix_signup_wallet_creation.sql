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

-- Remove any old auth trigger whose function still references the mistaken walletw table.
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
      AND pg_get_functiondef(p.oid) ILIKE '%walletw%'
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
