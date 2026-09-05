-- Durable customer feedback, announcements and Resend outbox.
-- Apply before deploying the corresponding API. Only service_role can write.
BEGIN;

CREATE TABLE public.customer_reviews (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  category text NOT NULL CHECK (category IN ('experience', 'issue', 'idea')),
  rating integer CHECK (rating BETWEEN 1 AND 5),
  message text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_reviews_user_created ON public.customer_reviews(user_id, created_at DESC);
CREATE INDEX customer_reviews_created ON public.customer_reviews(created_at DESC);

CREATE TABLE public.customer_email_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  unsubscribe_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.customer_email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('signup_checkin','purchase_feedback','credits_finished','subscription_finished','first_purchase_reminder','admin_review')),
  event_key text NOT NULL UNIQUE,
  source_id uuid,
  due_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','cancelled','failed')),
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  locked_until timestamptz,
  lease_id uuid,
  payload jsonb,
  provider_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX customer_email_jobs_due ON public.customer_email_jobs(status, due_at);

CREATE TABLE public.customer_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  kind text NOT NULL DEFAULT 'update' CHECK (kind IN ('update','maintenance')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

ALTER TABLE public.customer_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_email_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_email_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_reviews, public.customer_email_preferences, public.customer_email_jobs, public.customer_announcements FROM anon, authenticated;
GRANT ALL ON public.customer_reviews, public.customer_email_preferences, public.customer_email_jobs, public.customer_announcements TO service_role;

CREATE FUNCTION public.morphly_enqueue_email(p_user uuid, p_kind text, p_key text, p_source uuid DEFAULT NULL, p_due timestamptz DEFAULT now())
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.customer_email_jobs(user_id, kind, event_key, source_id, due_at)
  VALUES(p_user, p_kind, p_key, p_source, p_due)
  ON CONFLICT(event_key) DO NOTHING;
$$;

CREATE FUNCTION public.morphly_submit_review(p_user uuid, p_id uuid, p_category text, p_rating integer, p_message text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email text; v_existing public.customer_reviews;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
  SELECT * INTO v_existing FROM public.customer_reviews WHERE id = p_id;
  IF FOUND THEN
    IF v_existing.user_id <> p_user OR v_existing.message <> btrim(p_message)
      OR v_existing.category <> p_category OR v_existing.rating IS DISTINCT FROM p_rating THEN
      RAISE EXCEPTION 'Review request conflicts with an existing submission';
    END IF;
    RETURN p_id;
  END IF;
  IF (SELECT count(*) FROM public.customer_reviews WHERE user_id = p_user AND created_at > now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'You can send up to five reviews per day. Please try again tomorrow.';
  END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = p_user;
  IF v_email IS NULL THEN RAISE EXCEPTION 'Account email unavailable'; END IF;
  INSERT INTO public.customer_reviews(id, user_id, email, category, rating, message)
  VALUES(p_id, p_user, v_email, p_category, p_rating, btrim(p_message));
  PERFORM public.morphly_enqueue_email(p_user, 'admin_review', 'review:' || p_id, p_id);
  RETURN p_id;
END;
$$;

CREATE FUNCTION public.morphly_purchase_feedback_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF lower(NEW.status) IN ('success','successful','completed')
    AND coalesce(NEW.transaction_type, NEW.type) = 'credit_purchase'
    AND coalesce(NEW.refund_status, 'none') = 'none' THEN
    PERFORM public.morphly_enqueue_email(NEW.user_id, 'purchase_feedback', 'purchase:' || NEW.id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER morphly_purchase_feedback AFTER INSERT OR UPDATE OF status ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.morphly_purchase_feedback_trigger();

CREATE FUNCTION public.morphly_credits_feedback_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_purchase uuid;
BEGIN
  IF OLD.credits > 0 AND NEW.credits <= 0 THEN
    SELECT id INTO v_purchase FROM public.transactions
    WHERE user_id = NEW.user_id AND coalesce(transaction_type, type) = 'credit_purchase'
      AND lower(status) IN ('success','successful','completed') AND coalesce(refund_status, 'none') = 'none'
    ORDER BY created_at DESC, id DESC LIMIT 1;
    IF v_purchase IS NOT NULL THEN
      PERFORM public.morphly_enqueue_email(NEW.user_id, 'credits_finished', 'credits-finished:' || v_purchase, v_purchase);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER morphly_credits_feedback AFTER UPDATE OF credits ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.morphly_credits_feedback_trigger();

-- A scheduled sweep also covers users who never return to the app.
CREATE FUNCTION public.morphly_schedule_customer_emails(p_inactivity_days integer DEFAULT 14)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_inactivity_days < 1 OR p_inactivity_days > 365 THEN RAISE EXCEPTION 'Invalid reminder interval'; END IF;
  INSERT INTO public.customer_email_jobs(user_id, kind, event_key)
  SELECT u.id, 'signup_checkin', 'signup:' || u.id FROM auth.users u
  WHERE u.email_confirmed_at IS NOT NULL AND u.created_at <= now() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM public.customer_email_jobs j WHERE j.event_key = 'signup:' || u.id)
    AND NOT EXISTS (SELECT 1 FROM public.customer_email_preferences p WHERE p.user_id = u.id AND NOT p.enabled)
    AND NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = u.id AND coalesce(t.transaction_type, t.type) = 'credit_purchase' AND lower(t.status) IN ('success','successful','completed'))
  LIMIT 1000 ON CONFLICT(event_key) DO NOTHING;

  INSERT INTO public.customer_email_jobs(user_id, kind, event_key, source_id)
  SELECT t.user_id, 'first_purchase_reminder', 'first-purchase-reminder:' || t.user_id, t.id
  FROM public.transactions t
  WHERE coalesce(t.transaction_type, t.type) = 'credit_purchase'
    AND lower(t.status) IN ('success','successful','completed') AND coalesce(t.refund_status, 'none') = 'none'
    AND t.created_at <= now() - make_interval(days => p_inactivity_days)
    AND NOT EXISTS (SELECT 1 FROM public.transactions t2 WHERE t2.user_id = t.user_id AND t2.id <> t.id
      AND coalesce(t2.transaction_type, t2.type) = 'credit_purchase' AND lower(t2.status) IN ('success','successful','completed'))
    AND NOT EXISTS (SELECT 1 FROM public.customer_email_jobs j WHERE j.event_key = 'first-purchase-reminder:' || t.user_id)
  LIMIT 1000 ON CONFLICT(event_key) DO NOTHING;

  INSERT INTO public.customer_email_jobs(user_id, kind, event_key, source_id)
  SELECT s.user_id, 'subscription_finished', 'subscription-finished:' || s.id, s.id
  FROM public.subscriptions s WHERE s.status = 'expired' OR (s.status = 'active' AND s.ends_at <= now())
  ON CONFLICT(event_key) DO NOTHING;
END;
$$;

-- Multiple cron invocations safely claim separate jobs. After the provider's
-- 24-hour idempotency window, ambiguous deliveries need manual investigation.
CREATE FUNCTION public.morphly_claim_customer_email(p_user uuid DEFAULT NULL, p_job uuid DEFAULT NULL)
RETURNS SETOF public.customer_email_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.customer_email_jobs SET status = 'failed', last_error = 'Delivery needs review; retry window expired'
  WHERE status IN ('pending','processing') AND first_attempt_at < now() - interval '23 hours';
  RETURN QUERY WITH candidate AS (
    SELECT j.id FROM public.customer_email_jobs j
    WHERE ((j.status = 'pending' AND j.due_at <= now()) OR (j.status = 'processing' AND j.locked_until < now()))
      AND (p_user IS NULL OR j.user_id = p_user) AND (p_job IS NULL OR j.source_id = p_job)
    ORDER BY j.due_at, j.id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE public.customer_email_jobs j SET status = 'processing', attempts = attempts + 1,
      first_attempt_at = coalesce(first_attempt_at, now()), locked_until = now() + interval '10 minutes', lease_id = gen_random_uuid()
    FROM candidate c WHERE j.id = c.id RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.morphly_enqueue_email(uuid,text,text,uuid,timestamptz), public.morphly_submit_review(uuid,uuid,text,integer,text), public.morphly_purchase_feedback_trigger(), public.morphly_credits_feedback_trigger(), public.morphly_schedule_customer_emails(integer), public.morphly_claim_customer_email(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.morphly_enqueue_email(uuid,text,text,uuid,timestamptz), public.morphly_submit_review(uuid,uuid,text,integer,text), public.morphly_schedule_customer_emails(integer), public.morphly_claim_customer_email(uuid,uuid) TO service_role;
COMMIT;
