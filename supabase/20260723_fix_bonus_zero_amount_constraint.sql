-- Hotfix for databases where 20260723_onboarding_camera_referrals.sql was
-- applied over an early Morphly transactions table.
--
-- Signup and referral grants have zero monetary value. Older schemas rejected
-- amount = 0 before transaction_type existed, which makes the auth signup
-- trigger fail with "Database error saving new user".

BEGIN;

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

COMMIT;
