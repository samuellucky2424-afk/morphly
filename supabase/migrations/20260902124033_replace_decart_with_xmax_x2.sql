-- Replace the realtime provider defaults without rewriting historical Decart rows.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'xmax',
  ADD COLUMN IF NOT EXISTS provider_model TEXT NOT NULL DEFAULT 'x2.0';

ALTER TABLE public.sessions
  ALTER COLUMN provider SET DEFAULT 'xmax',
  ALTER COLUMN provider_model SET DEFAULT 'x2.0';

CREATE INDEX IF NOT EXISTS idx_analytics_events_xmax_keys
  ON public.analytics_events(user_id, created_at DESC)
  WHERE event_name = 'xmax_key_issued';

-- Keep legacy error rows when the optional admin logging table is installed,
-- while allowing environments without that table to run this migration.
DO $migration$
BEGIN
  IF to_regclass('public.error_logs') IS NOT NULL THEN
    ALTER TABLE public.error_logs
      ADD COLUMN IF NOT EXISTS provider_stage TEXT;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'error_logs'
        AND column_name = 'decart_stage'
    ) THEN
      UPDATE public.error_logs
      SET provider_stage = decart_stage
      WHERE provider_stage IS NULL
        AND decart_stage IS NOT NULL;
    END IF;

    COMMENT ON COLUMN public.error_logs.provider_stage IS
      'Provider-neutral realtime pipeline stage associated with the error.';
  END IF;
END
$migration$;

COMMENT ON COLUMN public.sessions.provider IS
  'Realtime AI provider used by the session. New sessions default to Xmax.';
COMMENT ON COLUMN public.sessions.provider_model IS
  'Provider model identifier. New sessions default to Xmax X2.0.';

-- The existing atomic billing functions are deliberately retained. Replace
-- only their legacy provider-specific ledger description, if that text is
-- present in the deployed definitions.
DO $migration$
DECLARE
  function_signature TEXT;
  function_oid REGPROCEDURE;
  function_definition TEXT;
  updated_definition TEXT;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.record_ai_session_usage(uuid,uuid,integer)',
    'public.finalize_ai_session(uuid,uuid,integer,text)'
  ]
  LOOP
    function_oid := to_regprocedure(function_signature);
    IF function_oid IS NULL THEN
      CONTINUE;
    END IF;

    SELECT pg_get_functiondef(function_oid) INTO function_definition;
    updated_definition := replace(
      function_definition,
      'Decart realtime generation usage',
      'AI realtime generation usage'
    );

    IF updated_definition IS DISTINCT FROM function_definition THEN
      EXECUTE updated_definition;
    END IF;
  END LOOP;
END
$migration$;
