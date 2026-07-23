-- Compatibility hotfix for production installations whose transactions table
-- predates the verified-purchase and referral migrations.
--
-- Safe to run more than once. Existing transactions, wallets, and balances are
-- not changed.

BEGIN;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS wallet_id UUID REFERENCES public.wallets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amount_naira NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS transaction_type TEXT,
  ADD COLUMN IF NOT EXISTS related_user_id UUID,
  ADD COLUMN IF NOT EXISTS related_payment_id UUID;

-- Normalize the historical transaction type constraint. The constraint is
-- added NOT VALID so old rows are preserved while all future writes are
-- checked against the values used by Morphly.
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

-- Signup and referral grants carry credits but no monetary payment amount.
-- Remove only historical checks that reject a zero value in the base amount
-- column. Positive-amount verification remains enforced by the trusted payment
-- RPC before purchased credits are granted.
DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass
      AND contype = 'c'
      AND (
        regexp_replace(
          pg_get_expr(conbin, conrelid),
          '[[:space:]]+',
          '',
          'g'
        ) ~* '(^|[^a-z_])amount(<>|!=)\(?0'
        OR regexp_replace(
          pg_get_expr(conbin, conrelid),
          '[[:space:]]+',
          '',
          'g'
        ) ~* '(^|[^a-z_])amount>\(?0'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.transactions DROP CONSTRAINT %I',
      constraint_record.conname
    );
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
