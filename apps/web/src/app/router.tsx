import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { LoginPage } from '../features/auth/components/login-page';
import { RequireAuth } from '../features/auth/components/require-auth';
import { AppShell } from './app-shell';

// Route-level code splitting (SPEC §8.3): each screen is its own chunk.
const MonitorPage = lazy(() => import('../features/monitor/components/monitor-page'));
const AlertQueuePage = lazy(() => import('../features/alerts/components/alert-queue-page'));
const AlertDetailPage = lazy(() => import('../features/alerts/components/alert-detail-page'));
const AccountPage = lazy(() => import('../features/accounts/components/account-page'));

const page = (node: ReactNode) => (
  <Suspense
    fallback={
      <p role="status" className="p-4 text-sm text-fg-muted">
        Loading…
      </p>
    }
  >
    {node}
  </Suspense>
);

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { path: '/', element: page(<MonitorPage />) },
      { path: '/alerts', element: page(<AlertQueuePage />) },
      { path: '/alerts/:id', element: page(<AlertDetailPage />) },
      { path: '/accounts/:id', element: page(<AccountPage />) },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
