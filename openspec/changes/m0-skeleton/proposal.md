# Proposal

## Why

FraudStream has no code yet. Milestone M0 (SPEC §17) lays the foundation every later milestone depends on: a strict TypeScript monorepo, a local Kafka (KRaft, 3 brokers) + PostgreSQL environment with all topics pre-created, the shared event contracts, and CI that gates every PR. Without it, M1–M8 cannot be built or verified consistently.

## What Changes

- Create the pnpm + Nx monorepo with the layout from SPEC §12 (`apps/`, `libs/`, `infra/`, `migrations/`, `scripts/`, `tests/`, `docs/`), TypeScript strict (`strict`, `noUncheckedIndexedAccess`), ESLint (incl. `eslint-plugin-security`), Prettier and a Husky pre-commit hook (SPEC §2).
- Add `infra/docker-compose.yml` with 3 Kafka brokers in KRaft mode, PostgreSQL 16, kafka-ui and an `init-topics` container that creates every topic from SPEC §4.1 with explicit config; profiles `core` and `lowmem` (SPEC §14.1).
- Add `infra/postgres/init-roles.sql` creating one schema and one least-privilege DB role per service (SPEC §5).
- Create `libs/contracts`: event envelope, all v1 event payload schemas, topic names and consumer group names as Zod schemas/constants (SPEC §4.8, §4.9, §4.10).
- Add `.env.example` (SPEC §14.3) and `.gitignore` rules for secrets.
- Add `.github/workflows/ci.yml` running lint, typecheck and unit tests on every PR (SPEC §15, jobs 1–2).

Out of scope for M0: any service implementation, observability compose file (M7), TLS profile, integration/contract/security/e2e CI jobs (added by the milestones that introduce them), ADRs other than recording the Kafka client choice placeholder.

## Capabilities

### New Capabilities
- `local-environment`: one-command local stack (Kafka KRaft cluster, PostgreSQL with per-service schemas/roles, kafka-ui) and its profiles.
- `kafka-topics`: the topic catalogue with keys, partitions, replication, retention and broker safety settings, created explicitly at startup.
- `event-contracts`: the shared event envelope and v1 payload schemas every producer and consumer validates against.
- `ci-pipeline`: the automated quality gate (lint, typecheck, unit tests) that runs on every pull request.

### Modified Capabilities
<!-- none: greenfield project -->

## Impact

- New root files: `package.json`, `pnpm-workspace.yaml`, `nx.json`, `tsconfig.base.json`, ESLint/Prettier config, `.husky/`, `.env.example`, `.gitignore`.
- New `infra/` (compose, `kafka/init-topics.sh`, `postgres/init-roles.sql`), `libs/contracts`, `.github/workflows/ci.yml`.
- Dependencies: pnpm, Nx, TypeScript, Zod, Vitest (or Jest), ESLint, Prettier, Husky; Docker images for Kafka (KRaft), PostgreSQL 16, Kafbat UI.
