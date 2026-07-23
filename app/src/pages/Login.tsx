import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Video, Loader2, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { validateReferralCode } from '@/lib/account';
import {
  getReferralCodeFormatError,
  normalizeReferralCode,
} from '@/utils/referralCode';

const PASSWORD_RESET_URL = 'https://morphly-alpha.vercel.app/reset-password';

function Login() {
  const location = useLocation();
  const { login, register, loading, error, clearError } = useAuth();
  const [isLogin, setIsLogin] = useState(() => location.pathname !== '/signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const [referralError, setReferralError] = useState<string | null>(null);
  const [referralValid, setReferralValid] = useState(false);
  const [validatingReferral, setValidatingReferral] = useState(false);

  useEffect(() => {
    const signupMode = location.pathname === '/signup';
    setIsLogin(!signupMode);

    if (signupMode) {
      const queryCode = normalizeReferralCode(new URLSearchParams(location.search).get('ref') || '');
      if (queryCode) setReferralCode(queryCode);
    }
  }, [location.pathname, location.search]);

  const handleForgotPassword = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      toast.error('Enter your email address first.');
      return;
    }
    setResetLoading(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo: PASSWORD_RESET_URL });
      if (resetError) throw resetError;
      toast.success('Password reset email sent. Check your inbox and spam folder.');
    } catch (resetError) {
      toast.error(resetError instanceof Error ? resetError.message : 'Unable to send password reset email.');
    } finally {
      setResetLoading(false);
    }
  };

  useEffect(() => {
    if (error) {
      toast.error(error);
      clearError();
    }
  }, [error, clearError]);

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
    
    try {
      if (isLogin) {
        await login(email, password);
        toast.success('Welcome back!');
      } else {
        if (!(await checkReferralCode())) return;
        await register(email, name, password, referralCode);
        toast.success('Account created successfully!');
      }
    } catch (_err) {
      // Error is handled by the auth context and shown via toast
    }
  };

  const toggleMode = () => {
    setIsLogin((current) => !current);
    setReferralError(null);
    setReferralValid(false);
    clearError();
  };

  return (
    <div className="min-h-screen bg-[#0f0f10] flex items-center justify-center p-4">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-lg bg-[#1a1a1b] flex items-center justify-center">
            <Video className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-semibold text-white tracking-tight">Morphly</span>
        </div>

        <Card className="bg-[#18181b] border-[#27272a]">
          <CardHeader className="pb-6">
            <CardTitle className="text-xl font-semibold text-white text-center">
              {isLogin ? 'Sign in to your account' : 'Create your account'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {!isLogin && (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-[#a1a1aa]">Full Name</label>
                    <Input
                      type="text"
                      placeholder="Jane Doe"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="h-11 bg-[#27272a] border-[#3f3f46] text-white placeholder:text-[#71717a]"
                      disabled={loading}
                      required={!isLogin}
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="referral-code" className="text-sm font-medium text-[#a1a1aa]">
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
                      className={`h-11 bg-[#27272a] text-white placeholder:text-[#71717a] ${
                        referralError
                          ? 'border-red-500 focus-visible:ring-red-500/30'
                          : referralValid
                            ? 'border-emerald-500 focus-visible:ring-emerald-500/30'
                            : 'border-[#3f3f46]'
                      }`}
                      disabled={loading || validatingReferral}
                    />
                    <p id="referral-code-help" className="text-xs leading-5 text-[#71717a]">
                      Have a referral code? Enter it here. Your referrer receives 200 credits after
                      your first successful credit purchase.
                    </p>
                    <p
                      id="referral-code-status"
                      className={`min-h-4 text-xs ${
                        referralError ? 'text-red-400' : referralValid ? 'text-emerald-400' : 'text-[#71717a]'
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
                <label className="text-sm font-medium text-[#a1a1aa]">Email</label>
                <Input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 bg-[#27272a] border-[#3f3f46] text-white placeholder:text-[#71717a]"
                  disabled={loading}
                  required
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-[#a1a1aa]">Password</label>
                  {isLogin && (
                    <button 
                      type="button" 
                      className="text-sm text-[#2563eb] hover:text-[#3b82f6]"
                      onClick={handleForgotPassword}
                      disabled={loading || resetLoading}
                    >
                      {resetLoading ? 'Sending…' : 'Forgot password?'}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11 bg-[#27272a] border-[#3f3f46] text-white placeholder:text-[#71717a] pr-10"
                    disabled={loading}
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#71717a] hover:text-white transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <Button
                type="submit"
                disabled={loading || validatingReferral}
                className="w-full h-11 bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-medium disabled:opacity-50"
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
              <span className="text-sm text-[#71717a]">
                {isLogin ? "Don't have an account? " : 'Already have an account? '}
                <button
                  type="button"
                  onClick={toggleMode}
                  className="text-[#2563eb] hover:text-[#3b82f6] font-medium"
                  disabled={loading}
                >
                  {isLogin ? 'Create account' : 'Sign in'}
                </button>
              </span>
            </div>
            <div className="mt-4 text-center">
              <Link 
                to="/subscription" 
                className="text-sm text-[#71717a] hover:text-white transition-colors"
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
