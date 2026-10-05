export function getFirebaseAuthErrorMessage(reason: unknown): string {
  const error = reason as {code?: string; message?: string} | null;
  switch (error?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'The email or password is incorrect. Check your email, use Forgot password, or use Google sign-in if that is how you registered.';
    case 'auth/user-token-expired':
    case 'auth/invalid-user-token':
    case 'auth/requires-recent-login':
      return 'Your sign-in session has expired. Sign in again to continue.';
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes, then try again.';
    case 'auth/network-request-failed': return 'Could not connect. Check your internet connection and try again.';
    case 'auth/email-already-in-use': return 'An account already exists for this email. Sign in or use Forgot password.';
    case 'auth/user-disabled': return 'This account is disabled. Contact Morphly support.';
    case 'auth/weak-password': return 'Choose a stronger password with at least eight characters.';
    default: return error?.message || 'Authentication could not finish. Please try again.';
  }
}
