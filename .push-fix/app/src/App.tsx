import { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { UIProvider } from '@/context/UIContext';
import { AppProvider } from '@/context/AppContext';
import { ProtectedRoute, PublicRoute } from '@/components/ProtectedRoute';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from '@/components/ui/sonner';
import { Navigation } from '@/components/Navigation';
import LoadingScreen from '@/components/LoadingScreen';
import { ROUTES } from '@/lib/routes';

const Login = lazy(() => import('@/pages/Login'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Wallet = lazy(() => import('@/pages/Wallet'));
const Subscription = lazy(() => import('@/pages/Subscription'));
const Settings = lazy(() => import('@/pages/Settings'));
const NotFound = lazy(() => import('@/pages/NotFound'));

function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AuthProvider>
          <UIProvider>
            <AppProvider>
              <Suspense fallback={<LoadingScreen />}>
                <Routes>
                  <Route
                    path={ROUTES.PUBLIC.LOGIN}
                    element={
                      <PublicRoute>
                        <Login />
                      </PublicRoute>
                    }
                  />
                  <Route
                    path={ROUTES.PUBLIC.SIGNUP}
                    element={
                      <PublicRoute>
                        <Login />
                      </PublicRoute>
                    }
                  />
                  <Route
                    path={ROUTES.PROTECTED.DASHBOARD}
                    element={
                      <ProtectedRoute>
                        <Navigation>
                          <Dashboard />
                        </Navigation>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path={ROUTES.PROTECTED.WALLET}
                    element={
                      <ProtectedRoute>
                        <Navigation>
                          <Wallet />
                        </Navigation>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path={ROUTES.PROTECTED.SUBSCRIPTION}
                    element={
                      <ProtectedRoute>
                        <Navigation>
                          <Subscription />
                        </Navigation>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path={ROUTES.PROTECTED.SETTINGS}
                    element={
                      <ProtectedRoute>
                        <Navigation>
                          <Settings />
                        </Navigation>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/"
                    element={<Navigate to={ROUTES.DEFAULT} replace />}
                  />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
              <Toaster />
            </AppProvider>
          </UIProvider>
        </AuthProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
