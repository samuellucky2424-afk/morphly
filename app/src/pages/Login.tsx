import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Video, Loader2, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { CONFIRM_EMAIL_MESSAGE, getPasswordResetUrl, normalizeEmail, RESET_REQUEST_MESSAGE } from '@/lib/auth-flow';
import { validateReferralCode } from '@/lib/account';
import {
  getReferralCodeFormatError,
  normalizeReferralCode,
} from '@/utils/referralCode';

function Login() {
  const location = useLocation();
  const { login, register, loading, error, clearError } = useAuth();
  const [isLogin, setIsLogin] = useState(() => location.pathname !== '/signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const requestInFlight = useRef(false);
  const [referralCode, setReferralCode] = useState('');
  const [referralError, setReferralError] = useState<string | null>(null);
  const [referralValid, setReferralValid] = useState(false);
  const [validatingReferral, setValidatingReferral] = useState(false);

  useEffect(() => {
    const signupMode = location.pathname === '/signup';
    setIsLogin(!signupMode);
    if (!signupMode && new URLSearchParams(location.search).get('reset') === '1') {
      setNotice('Enter your email address, then select Forgot password to request a new reset link.');
    }

    if (signupMode) {
      const queryCode = normalizeReferralCode(new URLSearchParams(location.search).get('ref') || '');
      if (queryCode) setReferralCode(queryCode);
    }
  }, [location.pathname, location.search]);

  const handleForgotPassword = async () => {
    if (requestInFlight.current || loading) return;
    clearError(); setRequestError(null); setNotice(null);
    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setRequestError('Enter a valid email address, then select Forgot password.');
      return;
    }
    requestInFlight.current = true;
    setResetLoading(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: getPasswordResetUrl(import.meta.env.VITE_AUTH_SITE_URL),
      });
      if (resetError) throw resetError;
      setNotice(RESET_REQUEST_MESSAGE);
    } catch (resetError) {
      setRequestError(resetError instanceof Error ? resetError.message : 'Unable to send the reset request. Please try again.');
    } finally {
      setResetLoading(false);
      requestInFlight.current = false;
    }
  };

  useEffect(() => {
    if (error || requestError || notice) feedbackRef.current?.focus();
  }, [error, requestError, notice]);

  const checkReferralCode = async (): Promise<boolean> => {
    const normalized = normalizeReferralCode(referralCode);
    setReferralCode(normalized);
    setReferralValid(false);

    if (!normalized) {
      setReferralError(null);
      return true;
    }

    const formatError = getReferralCodeFormatError(normalized);
    if (formatError) {
      setReferralError(formatError);
      return false;
    }

    setValidatingReferral(true);
    try {
      const valid = await validateReferralCode(normalized);
      setReferralValid(valid);
      setReferralError(valid ? null : 'This referral code is invalid.');
      return valid;
    } catch (validationError) {
      const message = validationError instanceof Error
        ? validationError.message
        : 'Unable to validate the referral code.';
      setReferralError(message);
      return false;
    } finally {
      setValidatingReferral(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (requestInFlight.current || loading) return;
    requestInFlight.current = true;
    clearError(); setRequestError(null); setNotice(null);
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        if (!(await checkReferralCode())) return;
        const outcome = await register(email, name, password, referralCode);
        if (outcome === 'confirmation_required') {
          setPassword('');
          setNotice(CONFIRM_EMAIL_MESSAGE);
        }
      }
    } catch (_err) {
      // The auth context retains the error; render it next to the form.
    } finally {
      requestInFlight.current = false;
    }
  };

  const toggleMode = () => {
    setIsLogin((current) => !current);
    setReferralError(null);
    setReferralValid(false);
    setNotice(null); setRequestError(null); setPassword('');
    clearError();
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
            <Video className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-semibold text-foreground tracking-tight">Morphly</span>
        </div>

        <Card className="bg-background border-border">
          <CardHeader className="pb-6">
            <CardTitle className="text-xl font-semibold text-foreground text-center">
              {isLogin ? 'Sign in to your account' : 'Create your account'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {(error || requestError || notice) && <p id="auth-feedback" ref={feedbackRef} tabIndex={-1}
                role={error || requestError ? 'alert' : 'status'}
                className={`rounded-md border bg-background p-3 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring ${error || requestError ? 'border-destructive/25 text-destructive' : 'border-border text-foreground'}`}>
                {error || requestError || notice}
              </p>}
              {!isLogin && (
                <>
                  <div className="space-y-2">
                    <label htmlFor="auth-name" className="text-sm font-medium text-muted-foreground">Full Name</label>
                    <Input
                      id="auth-name"
                      autoComplete="name"
                      type="text"
                      placeholder="Jane Doe"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="h-11 bg-background border-border text-foreground placeholder:text-muted-foreground"
                      disabled={loading}
                      required={!isLogin}
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="referral-code" className="text-sm font-medium text-muted-foreground">
                      Referral code (optional)
                    </label>
                    <Input
                      id="referral-code"
                      type="text"
                      inputMode="text"
                      autoCapitalize="characters"
                      autoComplete="off"
                      maxLength={12}
                      placeholder="Enter referral code"
                      value={referralCode}
                      onChange={(event) => {
                        setReferralCode(normalizeReferralCode(event.target.value));
                        setReferralError(null);
                        setReferralValid(false);
                      }}
                      onBlur={() => void checkReferralCode()}
                      aria-invalid={Boolean(referralError)}
                      aria-describedby="referral-code-help referral-code-status"
                      className={`h-11 bg-background text-foreground placeholder:text-muted-foreground ${
                        referralError
                          ? 'border-destructive/25 focus-visible:ring-destructive/30'
                          : referralValid
                            ? 'border-success/25 focus-visible:ring-success/30'
                            : 'border-border'
                      }`}
                      disabled={loading || validatingReferral}
                    />
                    <p id="referral-code-help" className="text-xs leading-5 text-muted-foreground">
                      Have a referral code? Enter it here. Your referrer receives 200 credits after
                      your first successful credit purchase.
                    </p>
                    <p
                      id="referral-code-status"
                      className={`min-h-4 text-xs ${
                        referralError ? 'text-destructive' : referralValid ? 'text-success' : 'text-muted-foreground'
                      }`}
                    >
                      {validatingReferral
                        ? 'Checking referral code...'
                        : referralError || (referralValid ? 'Referral code accepted.' : '')}
                    </p>
                  </div>
                </>
              )}
              <div className="space-y-2">
                <label htmlFor="auth-email" className="text-sm font-medium text-muted-foreground">Email</label>
                <Input
                  id="auth-email"
                  autoComplete="email"
                  autoCapitalize="none"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 bg-background border-border text-foreground placeholder:text-muted-foreground"
                  disabled={loading || resetLoading}
                  aria-describedby={error || requestError || notice ? 'auth-feedback' : undefined}
                  required
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="auth-password" className="text-sm font-medium text-muted-foreground">Password</label>
                  {isLogin && (
                    <button 
                      type="button" 
                      className="text-sm text-primary hover:text-primary"
                      onClick={handleForgotPassword}
                      disabled={loading || resetLoading}
                    >
                      {resetLoading ? 'Sending…' : 'Forgot password?'}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Input
                    id="auth-password"
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11 bg-background border-border text-foreground placeholder:text-muted-foreground pr-10"
                    disabled={loading}
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <Button
                type="submit"
                disabled={loading || validatingReferral || resetLoading}
                className="w-full h-11 bg-primary hover:bg-primary-hover text-primary-foreground font-medium disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Please wait...
                  </span>
                ) : (
                  isLogin ? 'Sign In' : 'Create Account'
                )}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <span className="text-sm text-muted-foreground">
                {isLogin ? "Don't have an account? " : 'Already have an account? '}
                <button
                  type="button"
                  onClick={toggleMode}
                  className="text-primary hover:text-primary font-medium"
                  disabled={loading || resetLoading || validatingReferral}
                >
                  {isLogin ? 'Create account' : 'Sign in'}
                </button>
              </span>
            </div>
            <div className="mt-4 text-center">
              <Link 
                to="/subscription" 
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                View pricing plans
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default Login;
