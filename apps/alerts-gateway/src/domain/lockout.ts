/** SPEC §7 Req. 8: 5 consecutive failures lock the account for 15 minutes. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface LoginState {
  failedLogins: number;
  lockedUntil: Date | null;
}

export const isLocked = (s: LoginState, now: Date): boolean =>
  s.lockedUntil !== null && s.lockedUntil.getTime() > now.getTime();

/**
 * State after a wrong password. The counter restarts after a lockout has expired, so a locked
 * user gets 5 fresh attempts once the 15 minutes are over.
 */
export function afterFailure(s: LoginState, now: Date): LoginState {
  const expired = s.lockedUntil !== null && s.lockedUntil.getTime() <= now.getTime();
  const failedLogins = (expired ? 0 : s.failedLogins) + 1;
  return failedLogins >= MAX_FAILED_LOGINS
    ? { failedLogins, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) }
    : { failedLogins, lockedUntil: expired ? null : s.lockedUntil };
}

export const afterSuccess = (): LoginState => ({ failedLogins: 0, lockedUntil: null });
