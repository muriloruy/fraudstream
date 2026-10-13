import type { Principal } from './types';

/**
 * The access token lives in this module only: never in localStorage or sessionStorage, so an
 * XSS cannot read a long-lived credential from storage (SPEC §8.2). The refresh token is an
 * httpOnly cookie the page cannot read at all; a reload gets a new access token from it.
 */
let accessToken: string | null = null;
let principal: Principal | null = null;
const listeners = new Set<() => void>();

export const session = {
  get token(): string | null {
    return accessToken;
  },
  get principal(): Principal | null {
    return principal;
  },
  set(token: string, user: Principal): void {
    accessToken = token;
    principal = user;
    listeners.forEach((l) => {
      l();
    });
  },
  clear(): void {
    accessToken = null;
    principal = null;
    listeners.forEach((l) => {
      l();
    });
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
