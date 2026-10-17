# Tasks

## 1. Design (SPEC §8.1)

> 1.1 — moved to M8 (`m8-performance-chaos-docs` task 5.4). Tokens-in-code first; `docs/frontend/tokens-studio.json` is the import source.

- [x] 1.2 Export tokens to `apps/web/src/styles/tokens.ts` and map them in `tailwind.config.ts`; verify a token change propagates to a sample component

## 2. App foundation (SPEC §8.3)

- [x] 2.1 Scaffold `apps/web` (Vite, React 18, TS strict, Tailwind, React Router with lazy routes, TanStack Query, Vitest + Testing Library); verify `pnpm nx build web` and a sample component test
- [x] 2.2 Generate API types from the gateway OpenAPI (`pnpm web:types`) and a typed fetch client with refresh-on-401; unit test for the retry-once logic
- [x] 2.3 Build `components/ui` (Button, Badge, Card, Table, Dialog, Input, Select, Toast) with Radix + Tailwind, focus rings and ARIA; component tests incl. keyboard interaction and axe checks
- [x] 2.4 Implement `useEventStream()` (EventSource with credentials, reconnection, dispatch to query cache); unit tests with a mocked EventSource
- [x] 2.5 Dark mode toggle (class strategy, persisted preference); verify both themes render tokens correctly

## 3. Screens (SPEC §8.2)

- [x] 3.1 Login with RHF + Zod, error and lockout states, in-memory token; tests for validation, lockout message and absence of tokens in web storage
- [x] 3.2 Live Monitor: KPI cards (lag admin-only), Recharts live chart (15 min), virtualized decision feed (max 200); tests for tick updates and role-based card
- [x] 3.3 Alert Queue: table, filters, sorting, keyset load more, real-time insert with highlight and "N new alerts" counter; tests for filters and the counter behavior
- [x] 3.4 Alert Detail: transaction card, score breakdown charts, mini-timeline, Assign/Confirm/Legitimate with required note and optimistic update + rollback; tests for rollback and note validation
- [x] 3.5 Account Timeline: profile, baseline stats, history, balance; test with mocked API data

> 3.6 — implementation screenshots done in `docs/frontend.md`; the Figma column moved to M8 (`m8-performance-chaos-docs` task 5.5).

## 4. Delivery and quality

- [x] 4.1 Production container (Caddy/nginx) with CSP and reverse proxy to the gateway; verify the CSP header with `curl -I`
- [x] 4.2 Playwright main flow: login → alert appears via SSE → resolve → status updates (SPEC §13.4); add to CI `e2e` job
- [x] 4.3 Lighthouse CI on `/alerts` asserting performance ≥ 90; verify the report in CI artifacts

## 5. Verification

- [x] 5.1 Run `pnpm lint && pnpm typecheck && pnpm test`; CI green; tick every M6 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m6-analyst-dashboard` after merge.
