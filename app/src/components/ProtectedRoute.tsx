import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import type { ReactNode } from 'react';
import { ROUTES } from '@/lib/routes';

interface RouteGuardProps {
  children: ReactNode;
  redirectTo?: string;
}

export function ProtectedRoute({ children, redirectTo }: RouteGuardProps) {
  const { isAuthenticated, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full border-4 border-primary/30 border-t-blue-500 animate-spin" />
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Navigate 
        to={redirectTo || ROUTES.PUBLIC.LOGIN} 
        state={{ from: location }} 
        replace 
      />
    );
  }

  return <>{children}</>;
}

export function AdminRoute({ children, redirectTo }: RouteGuardProps) {
  const { isAuthenticated, isAdmin, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full border-4 border-primary/30 border-t-blue-500 animate-spin" />
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to={redirectTo || ROUTES.PUBLIC.LOGIN}
        state={{ from: location }}
        replace
      />
    );
  }

  if (!isAdmin) {
    return <Navigate to={ROUTES.PROTECTED.DASHBOARD} replace />;
  }

  return <>{children}</>;
}

export function UserRoute({ children, redirectTo }: RouteGuardProps) {
  const { isAuthenticated, isAdmin, initializing, defaultRoute } = useAuth();
  const location = useLocation();

  if (initializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full border-4 border-primary/30 border-t-blue-500 animate-spin" />
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to={redirectTo || ROUTES.PUBLIC.LOGIN}
        state={{ from: location }}
        replace
      />
    );
  }

  if (isAdmin) {
    return <Navigate to={defaultRoute} replace />;
  }

  return <>{children}</>;
}

export function PublicRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading, initializing, defaultRoute } = useAuth();
  
  if (initializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full border-4 border-primary/30 border-t-blue-500 animate-spin" />
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (isAuthenticated && !loading) {
    return <Navigate to={defaultRoute} replace />;
  }

  return <>{children}</>;
}

interface AuthGuardProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function AuthGuard({ children, fallback }: AuthGuardProps) {
  const { isAuthenticated, initializing } = useAuth();

  if (initializing) {
    return fallback || null;
  }

  if (!isAuthenticated) {
    return fallback || null;
  }

  return <>{children}</>;
}
