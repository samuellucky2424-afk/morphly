-- Repair existing installations without changing billing logic or wallet data.
-- PostgREST supplies request.jwt.claims as JSON. The old singular claim setting
-- is unset, causing valid backend requests to fail with "Service role required".
-- auth.role() supports both formats and retains the service-role-only check.
BEGIN;

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
      RAISE EXCEPTION 'Missing %. Apply 20260908120000_add_atomic_session_billing_functions.sql first.',
        function_signature;
    END IF;

    SELECT pg_get_functiondef(function_oid) INTO function_definition;
    updated_definition := replace(
      function_definition,
      'current_setting(''request.jwt.claim.role'', true)',
      'auth.role()'
    );
    IF updated_definition IS DISTINCT FROM function_definition THEN
      EXECUTE updated_definition;
    ELSIF position('auth.role()' IN function_definition) = 0 THEN
      RAISE EXCEPTION 'Unrecognized role check in %; no changes applied.', function_signature;
    END IF;
  END LOOP;
END
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
