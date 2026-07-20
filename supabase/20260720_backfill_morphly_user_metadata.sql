-- Backfill missing user_metadata.app = 'morphly' for all existing profile-backed users
-- and ensure wallets are created for any older users missing them.
--
-- This fixes the issue where the Admin Dashboard only lists users who registered
-- recently (since the metadata tag was added to the signup flow).

BEGIN;

-- 1. Ensure all public.users have a corresponding wallet.
-- The previous migration may have missed some edge cases if the wallet trigger failed.
INSERT INTO public.wallets (user_id, balance, credits)
SELECT profile.id, 0, 0
FROM public.users AS profile
LEFT JOIN public.wallets AS wallet ON wallet.user_id = profile.id
WHERE wallet.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- 2. Backfill the `app: 'morphly'` metadata in auth.users for any user who has a
-- public.users profile, if they don't already have it.
UPDATE auth.users
SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || '{"app": "morphly"}'::jsonb
WHERE id IN (
  SELECT id FROM public.users
)
AND COALESCE(raw_user_meta_data->>'app', '') != 'morphly';

COMMIT;
