-- =============================================================================
-- MORPHLY ADMIN DASHBOARD SETUP
-- Run this in the Supabase SQL Editor after the core schema is already installed.
--
-- IMPORTANT:
-- 1. Create the admin's Supabase Auth user first using the requested email/password.
-- 2. This script grants the ADMIN ROLE by email. It does NOT store the password.
-- 3. auth.users deletion still requires the backend service-role API. RLS only applies
--    to the public schema tables below.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. ADMIN USERS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.admin_users (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'super_admin' CHECK (role IN ('super_admin', 'admin')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON public.admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON public.admin_users(is_active);

-- =============================================================================
-- 2. CREDIT PACKAGE TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.credit_packages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    credits INTEGER NOT NULL CHECK (credits > 0),
    price_ngn NUMERIC(12, 2) NOT NULL CHECK (price_ngn >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_packages_active ON public.credit_packages(is_active);
CREATE INDEX IF NOT EXISTS idx_credit_packages_sort_order ON public.credit_packages(sort_order);

-- =============================================================================
-- 3. HELPER FUNCTIONS
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_row_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_users_updated_at ON public.admin_users;
CREATE TRIGGER trg_admin_users_updated_at
    BEFORE UPDATE ON public.admin_users
    FOR EACH ROW EXECUTE FUNCTION public.set_row_updated_at();

DROP TRIGGER IF EXISTS trg_credit_packages_updated_at ON public.credit_packages;
CREATE TRIGGER trg_credit_packages_updated_at
    BEFORE UPDATE ON public.credit_packages
    FOR EACH ROW EXECUTE FUNCTION public.set_row_updated_at();

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.admin_users
        WHERE user_id = auth.uid()
          AND is_active = TRUE
    );
$$;

-- =============================================================================
-- 4. DEFAULT CREDIT PACKAGE DATA
-- =============================================================================
INSERT INTO public.credit_packages (name, credits, price_ngn, is_active, sort_order)
VALUES
    ('Starter', 500, 11500, TRUE, 1),
    ('Basic', 1000, 23000, TRUE, 2),
    ('Pro', 2000, 46000, TRUE, 3),
    ('Enterprise', 5000, 115000, TRUE, 4)
ON CONFLICT (name) DO UPDATE
SET credits = EXCLUDED.credits,
    price_ngn = EXCLUDED.price_ngn,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();

-- =============================================================================
-- 5. GRANT ADMIN ROLE TO THE REQUESTED EMAIL
-- =============================================================================
INSERT INTO public.admin_users (user_id, email, role, is_active)
SELECT id, email, 'super_admin', TRUE
FROM public.users
WHERE LOWER(email) = LOWER('luckysamuel1918@gmail.com')
ON CONFLICT (user_id) DO UPDATE
SET email = EXCLUDED.email,
    role = EXCLUDED.role,
    is_active = TRUE,
    updated_at = NOW();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.users
        WHERE LOWER(email) = LOWER('luckysamuel1918@gmail.com')
    ) THEN
        RAISE NOTICE 'No public.users row was found for luckysamuel1918@gmail.com. Create/sign in that Supabase Auth user first, then rerun the admin grant section.';
    END IF;
END;
$$;

-- =============================================================================
-- 6. ENABLE RLS
-- =============================================================================
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_packages ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 7. DROP OLD ADMIN POLICIES IF THEY EXIST
-- =============================================================================
DROP POLICY IF EXISTS "Users can view own admin membership" ON public.admin_users;
DROP POLICY IF EXISTS "Admins can view all admin users" ON public.admin_users;
DROP POLICY IF EXISTS "Admins can manage admin users" ON public.admin_users;

DROP POLICY IF EXISTS "Anyone can view active credit packages" ON public.credit_packages;
DROP POLICY IF EXISTS "Admins can view all credit packages" ON public.credit_packages;
DROP POLICY IF EXISTS "Admins can insert credit packages" ON public.credit_packages;
DROP POLICY IF EXISTS "Admins can update credit packages" ON public.credit_packages;
DROP POLICY IF EXISTS "Admins can delete credit packages" ON public.credit_packages;

DROP POLICY IF EXISTS "Admins can view all users" ON public.users;
DROP POLICY IF EXISTS "Admins can update all users" ON public.users;
DROP POLICY IF EXISTS "Admins can delete users" ON public.users;

DROP POLICY IF EXISTS "Admins can view all wallets" ON public.wallets;
DROP POLICY IF EXISTS "Admins can update all wallets" ON public.wallets;

DROP POLICY IF EXISTS "Admins can view all transactions" ON public.transactions;
DROP POLICY IF EXISTS "Admins can insert transactions" ON public.transactions;

DROP POLICY IF EXISTS "Admins can view all sessions" ON public.sessions;
DROP POLICY IF EXISTS "Admins can view all subscriptions" ON public.subscriptions;

-- =============================================================================
-- 8. ADMIN TABLE POLICIES
-- =============================================================================
CREATE POLICY "Users can view own admin membership"
ON public.admin_users FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all admin users"
ON public.admin_users FOR SELECT
USING (public.is_admin());

CREATE POLICY "Admins can manage admin users"
ON public.admin_users FOR ALL
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Anyone can view active credit packages"
ON public.credit_packages FOR SELECT
USING (is_active = TRUE OR public.is_admin());

CREATE POLICY "Admins can insert credit packages"
ON public.credit_packages FOR INSERT
WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update credit packages"
ON public.credit_packages FOR UPDATE
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete credit packages"
ON public.credit_packages FOR DELETE
USING (public.is_admin());

-- =============================================================================
-- 9. ADMIN ACCESS TO EXISTING APP TABLES
-- =============================================================================
CREATE POLICY "Admins can view all users"
ON public.users FOR SELECT
USING (public.is_admin());

CREATE POLICY "Admins can update all users"
ON public.users FOR UPDATE
USING (public.is_admin());

CREATE POLICY "Admins can delete users"
ON public.users FOR DELETE
USING (public.is_admin());

CREATE POLICY "Admins can view all wallets"
ON public.wallets FOR SELECT
USING (public.is_admin());

CREATE POLICY "Admins can update all wallets"
ON public.wallets FOR UPDATE
USING (public.is_admin());

CREATE POLICY "Admins can view all transactions"
ON public.transactions FOR SELECT
USING (public.is_admin());

CREATE POLICY "Admins can insert transactions"
ON public.transactions FOR INSERT
WITH CHECK (public.is_admin());

CREATE POLICY "Admins can view all sessions"
ON public.sessions FOR SELECT
USING (public.is_admin());

CREATE POLICY "Admins can view all subscriptions"
ON public.subscriptions FOR SELECT
USING (public.is_admin());

-- =============================================================================
-- COMPLETE
-- =============================================================================