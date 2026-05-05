import { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { UIProvider } from '@/context/UIContext';
import { AppProvider } from '@/context/AppContext';
import { AdminRoute, ProtectedRoute, PublicRoute, UserRoute } from '@/components/ProtectedRoute';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from '@/components/ui/sonner';
import Layout from '@/components/Layout';
import LoadingScreen from '@/components/LoadingScreen';
import { ROUTES } from '@/lib/routes';
import { useAuth } from '@/context/AuthContext';

const Login = lazy(() => import('@/pages/Login'));
const AdminDashboard = lazy(() => import('@/pages/AdminDashboard'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Wallet = lazy(() => import('@/pages/Wallet'));
const Subscription = lazy(() => import('@/pages/Subscription'));
const Settings = lazy(() => import('@/pages/Settings'));
const NotFound = lazy(() => import('@/pages/NotFound'));

function DefaultRouteRedirect() {
  const { defaultRoute } = useAuth();
  return <Navigate to={defaultRoute} replace />;
}

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
                    path={ROUTES.PROTECTED.SUBSCRIPTION}
                    element={<Subscription />}
                  />
                  <Route
                    path={ROUTES.PROTECTED.ADMIN}
                    element={
                      <AdminRoute>
                        <AdminDashboard />
                      </AdminRoute>
                    }
                  />
                  <Route
                    path="/"
                    element={
                      <ProtectedRoute>
                        <Layout />
                      </ProtectedRoute>
                    }
                  >
                    <Route index element={<DefaultRouteRedirect />} />
                    <Route
                      path={ROUTES.PROTECTED.WALLET}
                      element={
                        <UserRoute>
                          <Wallet />
                        </UserRoute>
                      }
                    />
                    <Route
                      path={ROUTES.PROTECTED.SETTINGS}
                      element={
                        <UserRoute>
                          <Settings />
                        </UserRoute>
                      }
                    />
                  </Route>
                  <Route
                    path={ROUTES.PROTECTED.DASHBOARD}
                    element={
                      <UserRoute>
                        <Dashboard />
                      </UserRoute>
                    }
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
