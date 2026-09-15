import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDefaultRoute, ROUTES } from '@/lib/routes';
import { apiFetch } from '@/lib/api-client';
import { supabase } from '@/lib/supabase';
import { trackLogin, trackSignupCompleted } from '@/lib/telemetry-client';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { normalizeReferralCode } from '@/utils/referralCode';
import { validateReferralCode } from '@/lib/account';
import { EXISTING_ACCOUNT_MESSAGE, getRegistrationOutcome, normalizeEmail } from '@/lib/auth-flow';
import type { RegistrationOutcome } from '@/lib/auth-flow';

// We map Supabase's user object properties to what our frontend expects where possible
interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  createdAt?: string;
  isAdmin: boolean;
  adminRole: string | null;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  adminRole: string | null;
  defaultRoute: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  register: (email: string, name: string, password: string, referralCode?: string) => Promise<RegistrationOutcome>;
  loading: boolean;
  initializing: boolean;
  error: string | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const hydrationRef = useRef<{ token: string; promise: Promise<User> } | null>(null);

  const getAdminState = useCallback(async (accessToken?: string | null) => {
    if (!accessToken) {
      return { isAdmin: false, adminRole: null as string | null };
    }

    try {
      const response = await apiFetch('/admin-me', {
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { isAdmin: false, adminRole: null as string | null };
      }

      if (!response.ok) {
        throw new Error(`Failed to load admin access (${response.status})`);
      }

      const data = await response.json();
      return {
        isAdmin: Boolean(data?.isAdmin),
        adminRole: typeof data?.role === 'string' ? data.role : null,
      };
    } catch (adminError) {
      console.warn('Failed to resolve admin access:', adminError);
      throw new Error('Unable to check account access. Please try signing in again.');
    }
  }, []);

  // Helper to map Supabase User
  const formatUser = (su: SupabaseUser, adminState?: { isAdmin: boolean; adminRole: string | null }): User => {
    return {
      id: su.id,
      name: su.user_metadata?.name || su.email?.split('@')[0] || 'User',
      email: su.email || '',
      avatar: su.user_metadata?.avatar_url,
      createdAt: su.created_at,
      isAdmin: Boolean(adminState?.isAdmin),
      adminRole: adminState?.adminRole ?? null,
    };
  };

  const ensureUserWallet = useCallback(async (accessToken?: string | null, required = false) => {
    if (!accessToken) {
      return;
    }

    try {
      const response = await apiFetch('/ensure-user-wallet', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        let message = `Wallet setup failed (${response.status})`;

        try {
          const data = await response.json();
          message = data?.error || message;
        } catch {
          // Keep the status-based fallback message.
        }

        if (required) {
          throw new Error(message);
        }

        console.warn('Wallet setup check failed:', message);
      }
    } catch (walletError) {
      if (required) {
        throw walletError;
      }

      console.warn('Wallet setup check failed:', walletError);
    }
  }, []);

  const hydrateUserFromSession = useCallback(async (currentSession: Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']) => {
    if (!currentSession?.user) {
      hydrationRef.current = null;
      setUser(null);
      setInitializing(false);
      return null;
    }

    // INITIAL_SESSION, SIGNED_IN and login can all arrive for the same token.
    // Share their work, and run independent setup checks concurrently.
    if (hydrationRef.current?.token !== currentSession.access_token) {
      hydrationRef.current = {
        token: currentSession.access_token,
        promise: Promise.all([
          ensureUserWallet(currentSession.access_token),
          getAdminState(currentSession.access_token),
        ]).then(([, adminState]) => formatUser(currentSession.user, adminState)),
      };
    }
    const hydration = hydrationRef.current;
    let nextUser: User;
    try {
      nextUser = await hydration.promise;
    } catch (hydrationError) {
      if (hydrationRef.current === hydration) {
        hydrationRef.current = null;
        setError(hydrationError instanceof Error ? hydrationError.message : 'Unable to restore your session.');
        setInitializing(false);
      }
      return null;
    }
    // A late response must not restore an account after sign-out/account change.
    if (hydrationRef.current !== hydration) return null;
    setUser(nextUser);
    setInitializing(false);
    return nextUser;
  }, [ensureUserWallet, getAdminState]);

  useEffect(() => {
    let active = true;
    // Check active session
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      if (active) void hydrateUserFromSession(currentSession);
    }).catch(() => {
      if (!active) return;
      setUser(null);
      setInitializing(false);
      setError('Unable to restore your session. Please sign in again.');
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, currentSession) => {
        if (event === 'USER_UPDATED') hydrationRef.current = null;
        void hydrateUserFromSession(currentSession);
      }
    );

    return () => {
      active = false;
      subscription.unsubscribe();
      hydrationRef.current = null;
    };
  }, [hydrateUserFromSession]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const login = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: normalizeEmail(email),
        password,
      });

      if (authError) {
        throw authError; // propagate up
      }

      if (!data.session) throw new Error('Unable to establish your session. Please sign in again.');
      const signedInUser = await hydrateUserFromSession(data.session);
      if (!signedInUser) return;
      
      navigate(getDefaultRoute(signedInUser.isAdmin), { replace: true });
      trackLogin();
    } catch (err: any) {
      const message = err.message || 'Login failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, name: string, password: string, referralCode?: string) => {
    setLoading(true);
    setError(null);
    
    try {
      if (name.trim().length < 2) {
        throw new Error('Name must be at least 2 characters');
      }

      const normalizedReferralCode = normalizeReferralCode(referralCode || '');
      if (normalizedReferralCode) {
        const referralIsValid = await validateReferralCode(normalizedReferralCode);
        if (!referralIsValid) {
          throw new Error('This referral code is invalid.');
        }
      }

      const { data, error: authError } = await supabase.auth.signUp({
        email: normalizeEmail(email),
        password,
        options: {
          data: {
            name: name.trim(),
            app: 'morphly',
            ...(normalizedReferralCode ? { referral_code: normalizedReferralCode } : {}),
          }
        }
      });

      if (authError) {
        if (authError.code === 'user_already_exists' || /already (?:registered|exists)/i.test(authError.message || '')) {
          throw new Error(EXISTING_ACCOUNT_MESSAGE);
        }
        if (/INVALID_REFERRAL_CODE/i.test(authError.message || '')) {
          throw new Error('This referral code is invalid.');
        }
        throw authError;
      }

      const outcome = getRegistrationOutcome(data, email);
      if (outcome === 'confirmation_required') return outcome;
      // Only the session returned by THIS signup may provision the account.
      const registeredSession = data.session;
      await ensureUserWallet(registeredSession?.access_token, true);
      const adminState = await getAdminState(registeredSession?.access_token);

      if (registeredSession?.user) {
        setUser(formatUser(registeredSession.user, adminState));
      }
      
      navigate(getDefaultRoute(adminState.isAdmin), { replace: true });
      trackSignupCompleted();
      return outcome;
    } catch (err: any) {
      const message = err.message || 'Registration failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = useCallback(async () => {
    setLoading(true);
    hydrationRef.current = null;
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setUser(null);
      setError(null);
      navigate(ROUTES.PUBLIC.LOGIN, { replace: true });
      setLoading(false);
    }
  }, [navigate]);

  const isAdmin = Boolean(user?.isAdmin);
  const adminRole = user?.adminRole ?? null;
  const defaultRoute = getDefaultRoute(isAdmin);

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated: !!user, 
      isAdmin,
      adminRole,
      defaultRoute,
      login, 
      logout, 
      register, 
      loading, 
      initializing,
      error,
      clearError 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
