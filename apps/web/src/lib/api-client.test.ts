import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyst } from '../test/utils';
import { authFetch, refreshSession } from './api-client';
import { session } from './session';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => new Response('{}', { status: code });
const req = (path: string) => new Request(`http://localhost:3000${path}`);

afterEach(() => {
  session.clear();
});

describe('authFetch: refresh on 401, retry once', () => {
  it('refreshes and retries once with the new token', async () => {
    session.set('expired', analyst);
    const seen: string[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      const r = input as Request;
      seen.push(`${new URL(r.url).pathname} ${r.headers.get('authorization') ?? '-'}`);
      if (new URL(r.url).pathname === '/auth/refresh')
        return Promise.resolve(ok({ accessToken: 'fresh', user: analyst }));
      return Promise.resolve(
        r.headers.get('authorization') === 'Bearer fresh' ? ok({ items: [] }) : status(401),
      );
    }) as unknown as typeof fetch;

    const res = await authFetch(fetchImpl)(req('/v1/alerts'));
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      '/v1/alerts Bearer expired',
      '/auth/refresh -',
      '/v1/alerts Bearer fresh',
    ]);
    expect(session.token).toBe('fresh');
  });

  it('does not retry when the refresh fails, and logs out', async () => {
    session.set('expired', analyst);
    const fetchImpl = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        status(new URL((input as Request).url).pathname === '/auth/refresh' ? 401 : 401),
      ),
    ) as unknown as typeof fetch;
    const res = await authFetch(fetchImpl)(req('/v1/alerts'));
    expect(res.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the request and the refresh, no retry
    expect(session.principal).toBeNull();
  });

  it('never retries auth routes', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(status(401))) as unknown as typeof fetch;
    await authFetch(fetchImpl)(req('/auth/login'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh between concurrent callers (rotation would see a second one as reuse)', async () => {
    let refreshes = 0;
    const fetchImpl = vi.fn(async () => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 10));
      return ok({ accessToken: 'fresh', user: analyst });
    }) as unknown as typeof fetch;
    const results = await Promise.all([
      refreshSession(fetchImpl),
      refreshSession(fetchImpl),
      refreshSession(fetchImpl),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(refreshes).toBe(1);
  });
});
