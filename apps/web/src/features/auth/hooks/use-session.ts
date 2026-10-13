import { useSyncExternalStore } from 'react';
import { session } from '../../../lib/session';
import type { Principal } from '../../../lib/types';

/** The logged-in principal (null when logged out); re-renders on login, refresh and logout. */
export function usePrincipal(): Principal | null {
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.principal,
  );
}
