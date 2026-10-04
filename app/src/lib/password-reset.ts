import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeEmail } from './auth-flow.ts';

type RecoveryAuth = Pick<SupabaseClient['auth'], 'resetPasswordForEmail' | 'verifyOtp' | 'getUser' | 'updateUser' | 'signOut'>;
export const CODE_SENT_MESSAGE = 'If an account exists for this email, you will receive a reset code. Check your inbox and spam folder.';

export function createPasswordResetFlow(auth: RecoveryAuth) {
  let verifiedUserId: string | null = null;
  return {
    async request(email: string) {
      verifiedUserId = null;
      const normalized = normalizeEmail(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid email address.');
      const { error } = await auth.resetPasswordForEmail(normalized);
      if (error) throw error;
    },
    async verify(email: string, code: string) {
      verifiedUserId = null;
      const token = code.replace(/\s/g, '');
      // Supabase projects can configure the email OTP length from 6 to 10.
      if (!/^\d{6,10}$/.test(token)) throw new Error('Enter the complete numeric code from your email.');
      const normalized = normalizeEmail(email);
      const { data, error } = await auth.verifyOtp({ email: normalized, token, type: 'recovery' });
      if (error) throw error;
      const verified = await auth.getUser();
      if (!data.session?.user.id || verified.error || verified.data.user?.id !== data.session.user.id ||
          normalizeEmail(verified.data.user.email || '') !== normalized) {
        throw new Error('The reset code could not be verified. Request a new code.');
      }
      verifiedUserId = verified.data.user.id;
    },
    async update(password: string, confirmation: string) {
      if (!verifiedUserId) throw new Error('Verify your reset code before changing your password.');
      if (password.length < 8) throw new Error('Use at least eight characters for your new password.');
      if (password !== confirmation) throw new Error('Passwords do not match.');
      const { data, error } = await auth.updateUser({ password });
      if (error) throw error;
      if (data.user?.id !== verifiedUserId) throw new Error('The password update could not be verified. Please try again.');
      verifiedUserId = null;
      try { await auth.signOut({ scope: 'local' }); } catch { /* Memory-only recovery session. */ }
    },
  };
}
