-- One UTC-second bucket per account: translation=2.5, video+translation=4 total.
-- Keep existing integer wallets compatible. A positive half-credit carry holds
-- change from rounded-up integer debits, so effective balances remain exact.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS billing_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS video_rate_half INTEGER NOT NULL DEFAULT 4;
CREATE TABLE public.realtime_credit_carry (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  half_credit INTEGER NOT NULL DEFAULT 0 CHECK (half_credit IN (0,1))
);
CREATE TABLE public.translation_sessions (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  started_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())),
  authorized_seconds INTEGER NOT NULL DEFAULT 0 CHECK (authorized_seconds BETWEEN 0 AND 7200),
  closed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX translation_one_open_per_user ON public.translation_sessions(user_id) WHERE closed_at IS NULL;
CREATE TABLE public.realtime_usage_seconds (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  epoch_second BIGINT NOT NULL,
  video_session UUID REFERENCES public.sessions(id), video_rate_half INTEGER NOT NULL DEFAULT 0 CHECK (video_rate_half IN (0,4,5,8)),
  translation_session UUID REFERENCES public.translation_sessions(id),
  cost_half INTEGER NOT NULL DEFAULT 0 CHECK (cost_half BETWEEN 0 AND 8),
  PRIMARY KEY(user_id, epoch_second)
);
CREATE INDEX realtime_usage_video_idx ON public.realtime_usage_seconds(video_session);
CREATE INDEX realtime_usage_translation_idx ON public.realtime_usage_seconds(translation_session);
ALTER TABLE public.realtime_credit_carry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_usage_seconds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.realtime_credit_carry, public.translation_sessions, public.realtime_usage_seconds FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.realtime_credit_carry, public.translation_sessions, public.realtime_usage_seconds TO service_role;

CREATE FUNCTION public.realtime_wallet_balance(p_user UUID) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  RETURN (SELECT w.credits + COALESCE(c.half_credit,0)/2.0 FROM public.wallets w
    LEFT JOIN public.realtime_credit_carry c ON c.user_id=w.user_id WHERE w.user_id=p_user);
END; $$;

-- Private helper. The caller holds the wallet lock throughout the transaction.
CREATE FUNCTION public.apply_realtime_second(p_user UUID, p_epoch BIGINT, p_video UUID,
  p_rate_half INTEGER, p_translation UUID, p_remove_translation BOOLEAN DEFAULT FALSE)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old public.realtime_usage_seconds%ROWTYPE; next_video UUID; next_voice UUID;
  next_rate INTEGER; next_cost INTEGER; available_half BIGINT; after_half BIGINT;
  old_wallet INTEGER; new_wallet INTEGER; delta INTEGER;
BEGIN
  SELECT * INTO old FROM public.realtime_usage_seconds WHERE user_id=p_user AND epoch_second=p_epoch;
  next_video := COALESCE(old.video_session,p_video);
  IF old.video_session IS NOT NULL AND p_video IS NOT NULL AND old.video_session<>p_video THEN
    RAISE EXCEPTION 'Overlapping video sessions';
  END IF;
  next_rate := GREATEST(COALESCE(old.video_rate_half,0),COALESCE(p_rate_half,0));
  next_voice := COALESCE(old.translation_session,p_translation);
  IF p_remove_translation AND old.translation_session=p_translation THEN next_voice:=NULL; END IF;
  next_cost := CASE WHEN next_voice IS NOT NULL AND next_video IS NOT NULL THEN 8
                   WHEN next_voice IS NOT NULL THEN 5 ELSE next_rate END;
  delta := next_cost-COALESCE(old.cost_half,0);
  SELECT credits INTO old_wallet FROM public.wallets WHERE user_id=p_user;
  INSERT INTO public.realtime_credit_carry(user_id) VALUES(p_user) ON CONFLICT DO NOTHING;
  SELECT old_wallet::BIGINT*2+half_credit INTO available_half FROM public.realtime_credit_carry WHERE user_id=p_user;
  IF delta>available_half THEN RETURN FALSE; END IF;
  after_half:=available_half-delta; new_wallet:=FLOOR(after_half/2.0);
  UPDATE public.wallets SET credits=new_wallet WHERE user_id=p_user;
  UPDATE public.realtime_credit_carry SET half_credit=MOD(after_half,2) WHERE user_id=p_user;
  INSERT INTO public.realtime_usage_seconds VALUES(p_user,p_epoch,next_video,next_rate,next_voice,next_cost)
    ON CONFLICT(user_id,epoch_second) DO UPDATE SET video_session=EXCLUDED.video_session,
    video_rate_half=EXCLUDED.video_rate_half, translation_session=EXCLUDED.translation_session,cost_half=EXCLUDED.cost_half;
  -- The existing ledger tracks integer-wallet movement. cost_half above plus
  -- the carry table provide an exact audit of fractional customer charges.
  IF old_wallet<>new_wallet THEN
    INSERT INTO public.wallet_ledger(user_id,delta,balance_after,entry_type,reason,idempotency_key)
    VALUES(p_user,new_wallet-old_wallet,new_wallet,'realtime_usage','Realtime usage; fractional change retained',
      'rt-second:'||p_user::TEXT||':'||p_epoch::TEXT)
    ON CONFLICT(idempotency_key) DO UPDATE SET delta=public.wallet_ledger.delta+EXCLUDED.delta,balance_after=EXCLUDED.balance_after;
  END IF;
  RETURN TRUE;
END; $$;

CREATE FUNCTION public.configure_realtime_video(p_user UUID,p_session UUID,p_rate_half INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_rate_half NOT IN (4,5,8) THEN RAISE EXCEPTION 'Invalid video rate'; END IF;
  UPDATE public.sessions SET billing_version=2,video_rate_half=p_rate_half
    WHERE id=p_session AND user_id=p_user AND status='active' AND COALESCE(seconds_used,0)=0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not available'; END IF;
  RETURN jsonb_build_object('billingVersion',2,'serverNow',FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000));
END; $$;

CREATE FUNCTION public.record_realtime_video_usage(p_user UUID,p_session UUID,p_epoch_seconds BIGINT[],p_close BOOLEAN DEFAULT FALSE,p_blended BOOLEAN DEFAULT FALSE,p_blended_seconds BIGINT[] DEFAULT ARRAY[]::BIGINT[])
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
    rate:=CASE WHEN s.video_rate_half=4 AND (p_blended OR sec=ANY(p_blended_seconds)) THEN 8 ELSE s.video_rate_half END;
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

CREATE FUNCTION public.authorize_translation_usage(p_user UUID,p_session UUID,p_seconds INTEGER,p_close BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.translation_sessions%ROWTYPE; i INTEGER; target INTEGER; tick RECORD;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_seconds IS NULL OR p_seconds<0 OR p_seconds>7200 THEN RAISE EXCEPTION 'Invalid translation duration'; END IF;
  PERFORM 1 FROM public.wallets WHERE user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  IF NOT p_close AND EXISTS(SELECT 1 FROM public.sessions WHERE user_id=p_user AND status='active' AND billing_version<>2) THEN
    RAISE EXCEPTION 'Restart face streaming in the updated app before translating';
  END IF;
  -- A dead relay cannot retain the account's single-session lease forever.
  -- Authorization already expired at started_epoch + authorized_seconds.
  UPDATE public.translation_sessions SET closed_at=clock_timestamp()
    WHERE user_id=p_user AND id<>p_session AND closed_at IS NULL
      AND started_epoch+authorized_seconds+30<FLOOR(EXTRACT(EPOCH FROM clock_timestamp()));
  INSERT INTO public.translation_sessions(id,user_id) VALUES(p_session,p_user) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO s FROM public.translation_sessions WHERE id=p_session AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Translation session ownership mismatch'; END IF;
  IF s.closed_at IS NOT NULL THEN RETURN jsonb_build_object('closed',TRUE,'authorizedSeconds',s.authorized_seconds,'remainingCredits',public.realtime_wallet_balance(p_user)); END IF;
  IF p_close THEN
    target:=LEAST(p_seconds,s.authorized_seconds);
    FOR tick IN SELECT epoch_second FROM public.realtime_usage_seconds WHERE translation_session=p_session AND epoch_second>=s.started_epoch+target LOOP
      PERFORM public.apply_realtime_second(p_user,tick.epoch_second,NULL,0,p_session,TRUE);
    END LOOP;
    UPDATE public.translation_sessions SET closed_at=clock_timestamp() WHERE id=p_session;
  ELSE
    IF p_seconds>FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))-s.started_epoch+5 THEN RAISE EXCEPTION 'Reservation too far ahead'; END IF;
    target:=s.authorized_seconds;
    IF p_seconds>target THEN
      FOR i IN target..p_seconds-1 LOOP
        IF NOT public.apply_realtime_second(p_user,s.started_epoch+i,NULL,0,p_session) THEN EXIT; END IF;
        target:=i+1;
      END LOOP;
    END IF;
    UPDATE public.translation_sessions SET authorized_seconds=target WHERE id=p_session;
  END IF;
  RETURN jsonb_build_object('closed',p_close,'authorizedSeconds',target,'startedAtMs',s.started_epoch*1000,'remainingCredits',public.realtime_wallet_balance(p_user));
END; $$;

-- A legacy heartbeat must never debit a timestamp-billed session again.
ALTER FUNCTION public.record_ai_session_usage(UUID,UUID,INTEGER) RENAME TO record_legacy_ai_session_usage;
CREATE FUNCTION public.record_ai_session_usage(p_user UUID,p_session UUID,p_seconds_delta INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF EXISTS(SELECT 1 FROM public.sessions WHERE id=p_session AND user_id=p_user AND billing_version=2) THEN
    RAISE EXCEPTION 'Timestamp billing required for this session';
  END IF;
  RETURN public.record_legacy_ai_session_usage(p_user,p_session,p_seconds_delta);
END; $$;

-- Keep existing cleanup/end-session callers from charging v2 video a second time.
ALTER FUNCTION public.finalize_ai_session(UUID,UUID,INTEGER,TEXT) RENAME TO finalize_legacy_ai_session;
CREATE FUNCTION public.finalize_ai_session(p_user UUID,p_session UUID,p_final_seconds_delta INTEGER DEFAULT 0,p_reason TEXT DEFAULT 'client_ended') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF EXISTS(SELECT 1 FROM public.sessions WHERE id=p_session AND user_id=p_user AND billing_version=2) THEN
    RETURN public.record_realtime_video_usage(p_user,p_session,ARRAY[]::BIGINT[],TRUE);
  END IF;
  RETURN public.finalize_legacy_ai_session(p_user,p_session,p_final_seconds_delta,p_reason);
END; $$;

REVOKE ALL ON FUNCTION public.apply_realtime_second(UUID,BIGINT,UUID,INTEGER,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.realtime_wallet_balance(UUID), public.configure_realtime_video(UUID,UUID,INTEGER),
  public.record_realtime_video_usage(UUID,UUID,BIGINT[],BOOLEAN,BOOLEAN,BIGINT[]),public.authorize_translation_usage(UUID,UUID,INTEGER,BOOLEAN),
  public.record_ai_session_usage(UUID,UUID,INTEGER),
  public.finalize_ai_session(UUID,UUID,INTEGER,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.realtime_wallet_balance(UUID), public.configure_realtime_video(UUID,UUID,INTEGER),
  public.record_realtime_video_usage(UUID,UUID,BIGINT[],BOOLEAN,BOOLEAN,BIGINT[]),public.authorize_translation_usage(UUID,UUID,INTEGER,BOOLEAN),
  public.record_ai_session_usage(UUID,UUID,INTEGER),
  public.finalize_ai_session(UUID,UUID,INTEGER,TEXT) TO service_role;
