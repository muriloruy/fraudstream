# Design

## Context

Greenfield repository (only `README.md`, `docs/SPEC.md`, `CLAUDE.md` and `openspec/`). See proposal.md for motivation. Every later milestone builds on the conventions fixed here, so choices that are expensive to change later (monorepo tool, partition count, contracts library shape) are decided now.

## Goals / Non-Goals

**Goals:**
- One `pnpm i` + one `docker compose up` gives a working stack.
- Conventions (folders, tsconfig, lint rules, test runner) that every app/lib inherits without copy-paste.
- Contracts usable by both NestJS services and the React app.

**Non-Goals:**
- No service code, migrations or DB tables beyond schemas/roles.
- No observability stack (M7) or TLS/Schema Registry profiles (stretch).

## Decisions

- **pnpm workspaces + Nx** (SPEC §2). Nx gives `affected` targets for CI and caching. Alternative Turborepo: simpler, but Nx's project graph and `nx affected` match the CI plan in SPEC §15. Workspaces: `apps/*`, `libs/*`, `scripts`.
- **Vitest** as the unit runner for libs and services (fast, native ESM/TS); NestJS testing utilities work with it via `unplugin-swc` for decorator metadata. Alternative Jest: default for Nest, but slower and needs ts-jest. Decision is reversible per project.
- **Kafka images**: `apache/kafka` (official, KRaft by default) for 3 combined broker+controller nodes; external listeners `localhost:19092/29092/39092` (SPEC §14.3). Alternative Bitnami/Confluent images: either works, official image avoids licensing/vendor drift.
- **Topic initializer** as a one-shot container running `infra/kafka/init-topics.sh` with `kafka-topics.sh --create --if-not-exists` and explicit `--config` per topic. The script reads the topic list from a single source (`infra/kafka/topics.conf`) that a contracts unit test cross-checks against the TypeScript constants, so the two cannot drift.
- **Retry/DLQ topics created upfront** for each `(source topic, consumer group)` pair in SPEC §4.1, since auto-create is disabled.
- **Postgres init** via `docker-entrypoint-initdb.d/init-roles.sql`: create schemas, one `<svc>_svc` LOGIN role each, `REVOKE ALL ON SCHEMA public FROM PUBLIC`, `GRANT USAGE, CREATE ON SCHEMA <svc>` to its role only. Passwords from env with `change-me` defaults matching `.env.example`. `citext` extension created for `auth` (SPEC §5.7).
- **Contracts with Zod**: `libs/contracts/src/{envelope.ts, events/*.ts, topics.ts, headers.ts, money.ts}`. Consumer schemas use `.strip()` (default) and never `.strict()`; producers can use `.strict()` in tests. Money uses a `DecimalString` refinement (regex `^\d{1,16}(\.\d{1,2})?$`). UUIDv7 validated by version nibble.
- **Lint**: flat ESLint config with `@typescript-eslint/strict-type-checked`, `eslint-plugin-security`, `no-explicit-any` as error, and a `no-restricted-syntax` rule forbidding tagged/template SQL with interpolation in `pg` calls (prepared for SPEC §7).
- **CI**: single `ci.yml` with `lint-typecheck` and `unit` jobs using `nx affected` on PRs and `nx run-many` on `main`; pnpm store cache. Other SPEC §15 jobs are added by the milestones that need them.

## Risks / Trade-offs

- [3 brokers use ~3 GB RAM] → `lowmem` profile with RF=1; `init-topics.sh` reads `REPLICATION_FACTOR`/`MIN_ISR` from env.
- [Topic list duplicated between shell script and TS] → single `topics.conf` + unit test asserting equality.
- [Kafka client choice (SPEC §2, ADR-003) not needed until M1] → stub `docs/adr/003-kafka-client.md` with the evaluation criteria; decision recorded in M1/M2.
- [Partition count fixed at 12 forever] → documented in ADR-002 stub; changing it requires new `*.v2` topics.

## Open Questions

- Exact Node LTS version to pin in `.nvmrc` (20 or 22) — either satisfies SPEC §2; pick the current LTS at implementation time.
