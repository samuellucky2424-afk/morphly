export const ROUTES = {
  PUBLIC: {
    LOGIN: '/login',
    SIGNUP: '/signup',
  },
  PROTECTED: {
    ADMIN: '/admin',
    DASHBOARD: '/dashboard',
    WALLET: '/wallet',
    SUBSCRIPTION: '/subscription',
    SETTINGS: '/settings',
  },
  DEFAULT: '/dashboard',
} as const;

export function getDefaultRoute(isAdmin: boolean): string {
  return isAdmin ? ROUTES.PROTECTED.ADMIN : ROUTES.PROTECTED.DASHBOARD;
}

export const PUBLIC_ROUTES = Object.values(ROUTES.PUBLIC);
export const PROTECTED_ROUTES = Object.values(ROUTES.PROTECTED);
export const ALL_ROUTES = [...PUBLIC_ROUTES, ...PROTECTED_ROUTES];
