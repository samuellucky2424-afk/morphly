-- =============================================================================
-- MORPHLY GENERATION-SECONDS BILLING FIX
-- Run this in the Supabase SQL Editor for the Morphly project.
--
-- This script only manages Morphly session usage columns:
--   public.sessions.seconds_used
--   public.sessions.cost
--   public.sessions.credits_used
--
-- It does not create, copy, drop, or modify any wallet tables.
-- =============================================================================

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS seconds_used INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cost NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS credits_used INTEGER DEFAULT 0;

UPDATE public.sessions
SET seconds_used = 0
WHERE seconds_used IS NULL OR seconds_used < 0;

UPDATE public.sessions
SET cost = 0
WHERE cost IS NULL OR cost < 0;

UPDATE public.sessions
SET credits_used = 0
WHERE credits_used IS NULL OR credits_used < 0;

ALTER TABLE public.sessions ALTER COLUMN seconds_used SET DEFAULT 0;
ALTER TABLE public.sessions ALTER COLUMN cost SET DEFAULT 0;
ALTER TABLE public.sessions ALTER COLUMN credits_used SET DEFAULT 0;

