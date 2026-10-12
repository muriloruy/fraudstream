# Design

## Context

Backend endpoints, SSE and OpenAPI come from M5. See proposal.md and the `analyst-dashboard` spec.

## Goals / Non-Goals

**Goals:** design-token parity between Figma and Tailwind; one SSE connection per tab feeding the query cache.

**Non-Goals:** component library publishing, i18n (UI in English; amounts formatted `pt-BR` for BRL), mobile-first optimization beyond responsive layout.

## Decisions

- **Structure**: `src/features/{auth,monitor,alerts,accounts}/{components,hooks,api}`, `src/components/ui/*`, `src/lib/{api-client,event-stream,auth}`.
- **Tokens**: Figma variables exported (Tokens Studio JSON or manual) to `src/styles/tokens.ts`, consumed by `tailwind.config.ts`; `darkMode: 'class'`.
- **UI primitives**: built on Radix UI primitives (Dialog, Select, Toast) for accessibility, styled with Tailwind. Alternative: hand-roll everything — more code, more a11y bugs.
- **Data**: TanStack Query with typed client from `openapi-typescript` + `openapi-fetch`; `useEventStream()` uses `EventSource` with credentials, dispatching `alert.*` into `['alerts']` caches via `setQueryData` and `metrics.tick` into a rolling 15-minute store.
- **Auth**: access token in a module-level variable; fetch wrapper retries once after `/auth/refresh` on 401; login form with React Hook Form + Zod.
- **Virtualization**: `@tanstack/react-virtual` for the decision feed and queue.
- **Serving**: production build served by Caddy (or nginx) container with CSP `default-src 'self'; connect-src 'self' <gateway>` and same-site cookies via reverse proxy to the gateway (avoids cross-site cookie issues).

## Risks / Trade-offs

- [Figma design time underestimated] → keep 4 screens, reuse components; design before code as SPEC §8.1 requires.
- [SSE through Vite dev proxy buffering] → configure proxy with no buffering; documented.
