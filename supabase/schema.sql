-- =============================================================================
-- MORPHLY CREDIT-BASED BILLING SCHEMA
-- Run this in Supabase SQL Editor
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. USERS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- 2. WALLETS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    credits INTEGER DEFAULT 0 CHECK (credits >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);

-- =============================================================================
-- 3. TRANSACTIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('credit_purchase', 'usage')),
    amount_naira NUMERIC(12, 2) DEFAULT 0,
    credits INTEGER NOT NULL DEFAULT 0,
    reference TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON public.transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.transactions(type);

-- =============================================================================
-- 4. SESSIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    start_time TIMESTAMPTZ DEFAULT NOW(),
    end_time TIMESTAMPTZ,
    credits_used INTEGER DEFAULT 0,
    seconds_used INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON public.sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON public.sessions(created_at DESC);

-- =============================================================================
-- 5. PLANS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    usd_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns if plans table already existed without them
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS usd_price NUMERIC(10, 2) DEFAULT 0;

-- Clear old plans and insert fresh
DELETE FROM public.plans WHERE name IN ('Starter', 'Basic', 'Pro', 'Enterprise');

INSERT INTO public.plans (name, credits, usd_price) VALUES
    ('Starter', 500, 10.00),
    ('Basic', 1000, 20.00),
    ('Pro', 2000, 40.00),
    ('Enterprise', 5000, 100.00);

-- =============================================================================
-- 6. SUBSCRIPTIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    plan_name TEXT NOT NULL,
    amount_paid NUMERIC(12, 2) DEFAULT 0,
    credits INTEGER NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);

-- =============================================================================
-- 7. EXCHANGE RATES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.exchange_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_currency TEXT NOT NULL DEFAULT 'USD',
    to_currency TEXT NOT NULL DEFAULT 'NGN',
    rate NUMERIC(12, 4) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_currency, to_currency)
);

INSERT INTO public.exchange_rates (from_currency, to_currency, rate)
VALUES ('USD', 'NGN', 1500.0000)
ON CONFLICT (from_currency, to_currency) DO UPDATE
SET rate = EXCLUDED.rate, updated_at = NOW();

-- =============================================================================
-- 8. AUTO-CREATE WALLET TRIGGER
-- =============================================================================
CREATE OR REPLACE FUNCTION public.create_wallet_for_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.wallets (user_id, credits) VALUES (NEW.id, 0);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_create_wallet ON public.users;
CREATE TRIGGER trg_create_wallet
    AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.create_wallet_for_user();

-- =============================================================================
-- 9. HELPER FUNCTIONS
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_user_credits(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE v_credits INTEGER;
BEGIN
    SELECT credits INTO v_credits FROM public.wallets WHERE user_id = p_user_id;
    RETURN COALESCE(v_credits, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.deduct_credits(p_user_id UUID, p_deduct INTEGER)
RETURNS JSON AS $$
DECLARE v_current INTEGER; v_final INTEGER; v_new INTEGER;
BEGIN
    SELECT credits INTO v_current FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    v_final := LEAST(v_current, p_deduct);
    v_new := GREATEST(0, v_current - v_final);
    UPDATE public.wallets SET credits = v_new WHERE user_id = p_user_id;
    RETURN json_build_object('success', TRUE, 'credits_deducted', v_final, 'remaining_credits', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.add_credits(p_user_id UUID, p_credits INTEGER, p_amount NUMERIC DEFAULT 0, p_ref TEXT DEFAULT NULL, p_plan TEXT DEFAULT 'Credit Purchase')
RETURNS JSON AS $$
DECLARE v_new INTEGER;
BEGIN
    UPDATE public.wallets SET credits = credits + p_credits WHERE user_id = p_user_id RETURNING credits INTO v_new;
    INSERT INTO public.transactions (user_id, type, amount_naira, credits, reference, description)
    VALUES (p_user_id, 'credit_purchase', p_amount, p_credits, p_ref, p_plan || ' purchased');
    INSERT INTO public.subscriptions (user_id, plan_name, amount_paid, credits, status)
    VALUES (p_user_id, p_plan, p_amount, p_credits, 'active');
    RETURN json_build_object('success', TRUE, 'credits_added', p_credits, 'new_credits', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 10. VALIDATION TRIGGER
-- =============================================================================
CREATE OR REPLACE FUNCTION public.validate_credits_update()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.credits < 0 THEN RAISE EXCEPTION 'Credits cannot be negative'; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_credits ON public.wallets;
CREATE TRIGGER trg_validate_credits
    BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.validate_credits_update();

-- =============================================================================
-- 11. ROW LEVEL SECURITY
-- =============================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;
DROP POLICY IF EXISTS "Service role can insert transactions" ON public.transactions;
DROP POLICY IF EXISTS "Users can view own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can insert own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can update own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Anyone can view plans" ON public.plans;
DROP POLICY IF EXISTS "Users can view own subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Service role can insert subscriptions" ON public.subscriptions;

CREATE POLICY "Users can view own profile" ON public.users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.users FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can view own wallet" ON public.wallets FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own wallet" ON public.wallets FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can view own transactions" ON public.transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role can insert transactions" ON public.transactions FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role');
CREATE POLICY "Users can view own sessions" ON public.sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own sessions" ON public.sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own sessions" ON public.sessions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Anyone can view plans" ON public.plans FOR SELECT USING (TRUE);
CREATE POLICY "Users can view own subscriptions" ON public.subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role can insert subscriptions" ON public.subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role');

-- =============================================================================
-- SCHEMA COMPLETE
-- =============================================================================
