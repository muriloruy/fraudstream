# Proposal

## Why

Analysts need a fast, accessible web interface to watch the stream, triage alerts and investigate accounts. Milestone M6 (SPEC §17) implements it in React + Tailwind tokens-in-code first (design tokens as the single source, exported for Figma); the Figma file is delivered in M8, completing "Figma to production-ready components" (SPEC §1.2 G6, §8).

## What Changes

- Design tokens in code (`src/styles/tokens.ts`), mirrored in `tailwind.config.ts` and exported as Tokens Studio JSON (SPEC §8.1).
- New app `apps/web` (React 18, Vite, Tailwind, TanStack Query, React Router, Recharts): Login + the 4 screens (SPEC §8.2).
- Shared accessible UI kit (`components/ui`), `useEventStream()` SSE hook writing into the query cache, forms with React Hook Form + Zod, API types generated from the gateway OpenAPI spec, dark mode, route-level code splitting (SPEC §8.3).
- Security: access token in memory only, refresh via httpOnly cookie, CSP, no `dangerouslySetInnerHTML` (SPEC §7).
- Tests: Vitest + Testing Library; Playwright main flow (login → alert via SSE → resolve).

Out of scope: README screenshots/GIF (M8); the Figma file and the Figma-vs-implementation comparison (moved to M8).

## Capabilities

### New Capabilities
- `analyst-dashboard`: the analyst-facing web application — screens, live updates, triage actions, accessibility and client-side security.

### Modified Capabilities
<!-- none -->

## Impact

- New `apps/web`, Playwright config under `tests/e2e/web`, nginx/Caddy static serving in compose with CSP headers, `pnpm web:types` (openapi-typescript).
