import createClient from 'openapi-fetch';
import type { paths } from './api-types';
import { session } from './session';
import type { LoginResponse } from './types';

export interface Problem {
  title: string;
  status: number;
  detail?: string;
  errors?: { field: string; message: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${String(status)}`);
    this.name = 'ApiError';
  }
}

let refreshing: Promise<boolean> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers share one request:
 * rotation revokes the presented token, so two parallel refreshes would look like reuse and
 * revoke the whole session (reuse detection).
 */
export function refreshSession(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const url = new URL('/auth/refresh', window.location.origin);
      const res = await fetchImpl(new Request(url, { method: 'POST', credentials: 'same-origin' }));
      if (!res.ok) {
        session.clear();
        return false;
      }
      const body = (await res.json()) as LoginResponse;
      session.set(body.accessToken, body.user);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * fetch with the bearer token; on 401 (expired access token) it refreshes once and retries
 * the request once. Auth routes are never retried.
 */
export function authFetch(fetchImpl: typeof fetch = fetch) {
  return async (input: Request): Promise<Response> => {
    const send = (req: Request) => {
      const headers = new Headers(req.headers);
      if (session.token) headers.set('authorization', `Bearer ${session.token}`);
      return fetchImpl(new Request(req, { headers, credentials: 'same-origin' }));
    };
    const retry = input.clone();
    const first = await send(input);
    if (first.status !== 401 || new URL(input.url).pathname.startsWith('/auth/')) return first;
    if (!(await refreshSession(fetchImpl))) return first;
    return send(retry);
  };
}

export const api = createClient<paths>({
  baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  fetch: authFetch((input, init) => fetch(input, init)),
});

/** Unwraps an openapi-fetch result: the data, or an ApiError with the Problem Details. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (data !== undefined && response.ok) return data;
  throw new ApiError(response.status, (error as Problem | undefined) ?? null);
}
