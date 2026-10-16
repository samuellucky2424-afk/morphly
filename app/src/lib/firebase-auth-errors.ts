// The desktop app loads from file://, where Google sign-in cannot run, so
// accounts created with Google on the web have no password there.
function isDesktopPage(): boolean {
  return typeof window !== 'undefined' && window.location?.protocol === 'file:';
}

export function getFirebaseAuthErrorMessage(reason: unknown, desktop = isDesktopPage()): string {
  const error = reason as {code?: string; message?: string} | null;
  switch (error?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return desktop
        ? 'The email or password is incorrect. If you created your account with Google on the website, select Forgot password to set a password for the desktop app, then sign in with it.'
        : 'The email or password is incorrect. Check your email, use Forgot password, or use Google sign-in if that is how you registered.';
    case 'auth/user-token-expired':
    case 'auth/invalid-user-token':
    case 'auth/requires-recent-login':
      return 'Your sign-in session has expired. Sign in again to continue.';
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes, then try again.';
    case 'auth/network-request-failed': return 'Could not connect. Check your internet connection and try again.';
    case 'auth/email-already-in-use': return desktop
      ? 'An account already exists for this email. Sign in instead. If you created it with Google on the website, select Forgot password to set a desktop password.'
      : 'An account already exists for this email. Sign in or use Forgot password.';
    case 'auth/user-disabled': return 'This account is disabled. Contact Morphly support.';
    case 'auth/weak-password': return 'Choose a stronger password with at least eight characters.';
    default: return error?.message || 'Authentication could not finish. Please try again.';
  }
}
