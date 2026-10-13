import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { refreshSession } from '../../../lib/api-client';
import { usePrincipal } from '../hooks/use-session';

/**
 * Guards the app routes. After a reload the in-memory token is gone, so it first tries the
 * refresh cookie; only if that fails does it send the user to /login (SPEC §8.2).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const principal = usePrincipal();
  const location = useLocation();
  const [checked, setChecked] = useState(principal !== null);

  useEffect(() => {
    if (principal || checked) return;
    void refreshSession().finally(() => {
      setChecked(true);
    });
  }, [principal, checked]);

  if (principal) return <>{children}</>;
  if (!checked) {
    return (
      <p role="status" className="p-8 text-sm text-fg-muted">
        Restoring session…
      </p>
    );
  }
  return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}
