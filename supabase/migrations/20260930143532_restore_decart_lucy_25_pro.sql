-- Plus: Vidu = 2 cr/sec; Pro: Decart Lucy 2.5 = 3 cr/sec.
-- Historic rates and combined video + translation (4 cr/sec) stay intact.
ALTER TABLE public.realtime_usage_seconds DROP CONSTRAINT realtime_usage_seconds_video_rate_half_check;
ALTER TABLE public.realtime_usage_seconds ADD CONSTRAINT realtime_usage_seconds_video_rate_half_check CHECK (video_rate_half IN (0,4,5,6,8));
ALTER TABLE public.sessions ALTER COLUMN provider SET DEFAULT 'vidu';
ALTER TABLE public.sessions ALTER COLUMN provider_model SET DEFAULT 's2-editing';
COMMENT ON COLUMN public.sessions.provider IS 'Realtime provider; new sessions select Vidu (Plus) or Decart (Pro).';
COMMENT ON COLUMN public.sessions.provider_model IS 'Provider model recorded per session.';

CREATE OR REPLACE FUNCTION public.configure_realtime_video(p_user UUID,p_session UUID,p_rate_half INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_rate_half IS NULL OR p_rate_half NOT IN (4,5,6,8) THEN RAISE EXCEPTION 'Invalid video rate'; END IF;
  UPDATE public.sessions SET billing_version=2,video_rate_half=p_rate_half
    WHERE id=p_session AND user_id=p_user AND status='active' AND COALESCE(seconds_used,0)=0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not available'; END IF;
  RETURN jsonb_build_object('billingVersion',2,'serverNow',FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000));
END; $$;


CREATE OR REPLACE FUNCTION public.record_realtime_video_usage(p_user UUID,p_session UUID,p_epoch_seconds BIGINT[],p_close BOOLEAN DEFAULT FALSE,p_blended BOOLEAN DEFAULT FALSE,p_blended_seconds BIGINT[] DEFAULT ARRAY[]::BIGINT[])
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.sessions%ROWTYPE; sec BIGINT; n INTEGER; rate INTEGER; stopped BOOLEAN:=FALSE; current_epoch BIGINT:=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()));
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  PERFORM 1 FROM public.wallets WHERE user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  SELECT * INTO s FROM public.sessions WHERE id=p_session AND user_id=p_user FOR UPDATE;
  IF NOT FOUND OR s.billing_version<>2 THEN RAISE EXCEPTION 'Session ownership or billing version mismatch'; END IF;
  IF s.status<>'active' THEN RETURN jsonb_build_object('shouldStop',TRUE,'remainingCredits',public.realtime_wallet_balance(p_user)); END IF;
  IF COALESCE(cardinality(p_epoch_seconds),0)>60 THEN RAISE EXCEPTION 'Too many usage seconds'; END IF;
  IF COALESCE(cardinality(p_blended_seconds),0)>60 THEN RAISE EXCEPTION 'Too many blended seconds'; END IF;
  SELECT COUNT(*) INTO n FROM public.realtime_usage_seconds WHERE video_session=p_session;
  FOR sec IN SELECT DISTINCT unnest(p_epoch_seconds) ORDER BY 1 LOOP
    IF sec IS NULL OR sec>current_epoch OR sec<current_epoch-120 OR sec<FLOOR(EXTRACT(EPOCH FROM s.start_time)) THEN RAISE EXCEPTION 'Invalid usage timestamp'; END IF;
    rate:=CASE WHEN s.video_rate_half=4 AND s.provider='xmax' AND (p_blended OR sec=ANY(p_blended_seconds)) THEN 8 ELSE s.video_rate_half END;
    IF n>=LEAST(COALESCE(s.provider_max_seconds,7200),7200)
      AND NOT EXISTS(SELECT 1 FROM public.realtime_usage_seconds WHERE user_id=p_user AND epoch_second=sec AND video_session=p_session)
      THEN stopped:=TRUE; EXIT; END IF;
    IF NOT public.apply_realtime_second(p_user,sec,p_session,rate,NULL) THEN stopped:=TRUE; EXIT; END IF;
    SELECT COUNT(*) INTO n FROM public.realtime_usage_seconds WHERE video_session=p_session;
  END LOOP;
  UPDATE public.sessions SET seconds_used=n,last_usage_at=clock_timestamp(),
    status=CASE WHEN p_close THEN 'ended' ELSE status END,
    end_time=CASE WHEN p_close THEN clock_timestamp() ELSE end_time END
    WHERE id=p_session;
  RETURN jsonb_build_object('totalBillableSeconds',n,'remainingCredits',public.realtime_wallet_balance(p_user),
    'shouldStop',stopped OR public.realtime_wallet_balance(p_user)<1.5);
END; $$;
