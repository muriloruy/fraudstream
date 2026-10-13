import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { usePrincipal } from '../features/auth/hooks/use-session';
import { api } from '../lib/api-client';
import { cn } from '../lib/cn';
import { useEventStream, type StreamStatus } from '../lib/event-stream';
import { session } from '../lib/session';
import { ThemeToggle } from './theme-toggle';

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Offline',
};

export function AppShell() {
  const principal = usePrincipal();
  const status = useEventStream(principal !== null);
  const navigate = useNavigate();
  const client = useQueryClient();

  const logout = async () => {
    await api.POST('/auth/logout');
    session.clear();
    client.clear();
    void navigate('/login', { replace: true });
  };

  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      'rounded-md px-3 py-2 text-sm font-medium',
      isActive ? 'bg-surface-muted text-fg' : 'text-fg-muted hover:text-fg',
    );

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded-md focus:bg-surface focus:p-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2">
          <span className="mr-4 font-semibold text-fg">FraudStream</span>
          <nav aria-label="Main" className="flex gap-1">
            <NavLink to="/" end className={link}>
              Live monitor
            </NavLink>
            <NavLink to="/alerts" className={link}>
              Alerts
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span role="status" className="flex items-center gap-1 text-xs text-fg-muted">
              <span
                aria-hidden
                className={cn(
                  'inline-block h-2 w-2 rounded-full',
                  status === 'open' ? 'bg-approve' : 'bg-review',
                )}
              />
              {/* eslint-disable-next-line security/detect-object-injection -- literal union key */}
              {STATUS_LABEL[status]}
            </span>
            <ThemeToggle />
            <span className="hidden text-sm text-fg-muted sm:inline">
              {principal?.email} ({principal?.role})
            </span>
            <Button variant="secondary" size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl p-4">
        <Outlet />
      </main>
    </div>
  );
}
