import type { Session, User } from '@supabase/supabase-js';

export type RegistrationOutcome = 'signed_in' | 'confirmation_required';
export const EXISTING_ACCOUNT_MESSAGE = 'An account already exists for this email. Sign in or use Forgot password.';
export const CONFIRM_EMAIL_MESSAGE = 'Check your inbox to confirm your email before signing in. If you already have an account, sign in or reset your password instead.';
export const RESET_REQUEST_MESSAGE = 'If an account exists for this email, you will receive a password reset link. Check your inbox and spam folder.';

export function normalizeEmail(email: string) { return email.trim().toLowerCase(); }

export function getPasswordResetUrl(configuredSite?: string): string {
  // This is the deployed app, not the marketing domain. Desktop links must open
  // an HTTPS page in the user's browser, never an Electron file:// URL.
  const url = new URL(configuredSite?.trim() || 'https://morphly-alpha.vercel.app');
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Password recovery needs a valid HTTPS app address.');
  return `${url.origin}/reset-password`;
}

export function getRegistrationOutcome(data: { user: User | null; session: Session | null }, email: string): RegistrationOutcome {
  if (!data.user || normalizeEmail(data.user.email || '') !== normalizeEmail(email)) {
    throw new Error('Registration could not be verified. Try signing in or request a password reset.');
  }
  if (!data.session && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    // Supabase can return an obfuscated user rather than an error for a repeat
    // signup. Do not grant a wallet, navigate or count this as a new signup.
    throw new Error(EXISTING_ACCOUNT_MESSAGE);
  }
  if (!data.session) return 'confirmation_required';
  if (!data.session.access_token || data.session.user?.id !== data.user.id) {
    throw new Error('Registration could not be verified. Please sign in to continue.');
  }
  return 'signed_in';
}
