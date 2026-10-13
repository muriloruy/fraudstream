import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { vi } from 'vitest';
import { ToastProvider } from '../components/ui/toast';
import { session } from '../lib/session';
import type { Principal } from '../lib/types';

export const analyst: Principal = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'analyst@demo.local',
  role: 'analyst',
};
export const admin: Principal = {
  ...analyst,
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
};

export function login(principal: Principal = analyst) {
  session.set('test-access-token', principal);
}

export const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** Renders `element` at `path` (matching `pattern`) inside the app providers. */
export function renderAt(element: ReactNode, path = '/', pattern = '/', client = newClient()) {
  const routes: RouteObject[] = [
    { path: pattern, element },
    { path: '*', element: <p>elsewhere</p> },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...result, client, router };
}

export type Route = (req: Request) => Response | Promise<Response> | undefined;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const problem = (status: number, title: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title, status }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** Stubs fetch with a list of handlers; the first one returning a Response wins. */
export function mockFetch(...routes: Route[]) {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), 'http://localhost:3000'), init);
    calls.push(req.clone());
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    return problem(404, 'Not Found');
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export const on =
  (
    method: string,
    path: string | RegExp,
    respond: (req: Request) => Response | Promise<Response>,
  ): Route =>
  (req) => {
    const url = new URL(req.url);
    const matchPath = typeof path === 'string' ? url.pathname === path : path.test(url.pathname);
    return req.method === method && matchPath ? respond(req) : undefined;
  };

/** axe-core violations of a rendered container (WCAG 2 A/AA rules). */
export async function a11yViolations(container: Element) {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout or computed colors
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}
