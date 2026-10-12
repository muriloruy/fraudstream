# Tasks

## 1. Monorepo foundation (SPEC §2, §12)

- [x] 1.1 Create root `package.json` (private, `packageManager: pnpm@<version>`, `engines.node >=20`), `pnpm-workspace.yaml` (`apps/*`, `libs/*`), `.nvmrc`, `.editorconfig`; verify `pnpm i` succeeds on a clean clone
- [x] 1.2 Add Nx (`nx.json` with `lint`, `typecheck`, `test`, `build` target defaults and caching); verify `pnpm nx graph --file=graph.json` runs
- [x] 1.3 Add `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, path aliases `@fraudstream/*` → `libs/*/src`; verify `pnpm typecheck` passes on an empty lib
- [x] 1.4 Create the folder skeleton from SPEC §12 (`apps/`, `libs/`, `infra/`, `migrations/`, `scripts/`, `tests/{e2e,load,chaos,security}`, `docs/{adr,security}`) with `.gitkeep` where empty; verify tree matches SPEC §12
- [x] 1.5 Configure ESLint flat config (`typescript-eslint` strict-type-checked, `eslint-plugin-security`, `no-explicit-any: error`, rule forbidding interpolated template-string SQL) and Prettier; add root scripts `lint`, `format`, `format:check`, `typecheck`, `test`; verify `pnpm lint` fails on a sample file with `any` and passes after removing it
- [x] 1.6 Configure Vitest workspace (coverage via v8) and a sample test; verify `pnpm test` runs and reports coverage
- [x] 1.7 Add Husky + lint-staged pre-commit (Prettier + ESLint on staged files) and commitlint with Conventional Commits; verify a commit with message `bad message` is rejected
- [x] 1.8 Update `.gitignore` (`node_modules`, `dist`, `coverage`, `.env`, `simulator_output/`, `.nx/`); verify `git status` ignores a created `.env`

## 2. Local infrastructure (SPEC §4.1, §5, §14)

- [x] 2.1 Write `infra/docker-compose.yml` with `kafka-1..3` (KRaft, combined broker+controller, `auto.create.topics.enable=false`, `min.insync.replicas=2`, `unclean.leader.election.enable=false`, external ports 19092/29092/39092) and healthchecks, profile `core`; verify `docker compose --profile core up -d` shows 3 healthy brokers
- [x] 2.2 Add `lowmem` profile with a single broker and env `REPLICATION_FACTOR=1`, `MIN_ISR=1`; verify the stack boots with `--profile lowmem`
- [x] 2.3 Create `infra/kafka/topics.conf` (name, partitions, cleanup policy, retention) for all topics of SPEC §4.1 including every `<topic>.<group>.retry` and `<topic>.<group>.dlq`, and `infra/kafka/init-topics.sh` that creates them idempotently with explicit config; add the `init-topics` one-shot service depending on healthy brokers; verify `kafka-topics.sh --describe` output matches SPEC §4.1 and a second run is a no-op
- [x] 2.4 Add a `scripts/verify-topics.sh` smoke check (partitions, RF, cleanup policy, retention per topic) and run it in the compose healthcheck docs; verify it exits 0 on a fresh stack and non-zero if a topic is deleted
- [x] 2.5 Add PostgreSQL 16 service with volume and healthcheck, and `infra/postgres/init-roles.sql` creating schemas `payments, vault, fraud_rules, anomaly, decision, ledger, alerts, auth`, one `<svc>_svc` role per service with access only to its schema, `citext` extension, and `REVOKE` on `public`; verify `payments_svc` gets `permission denied` on `vault` and can create a table in `payments`
- [x] 2.6 Add kafka-ui (Kafbat) on port 8080 pre-configured with the cluster; verify the UI lists all topics
- [x] 2.7 Write `.env.example` with every variable from SPEC §14.3 (one `DATABASE_URL_*` per service, placeholders only); verify compose starts using values copied from it
- [x] 2.8 Document the quick start (SPEC §14.2, M0 subset) in `README.md` and `docs/runbook.md` (start/stop, lowmem, reset volumes); verify the documented commands run as written

## 3. Shared contracts library (SPEC §4.2, §4.8–§4.10)

- [x] 3.1 Scaffold `libs/contracts` (Nx lib, `@fraudstream/contracts`, ESM, no runtime deps besides `zod`); verify `pnpm nx build contracts` succeeds
- [x] 3.2 Implement primitives: `DecimalString` money + ISO 4217 currency allow-list, ISO 3166-1 alpha-2 country, MCC, `MaskedPan` (first 6 / last 4), `UuidV7`, ISO datetime; unit tests cover floats, 3 decimals, unmasked PAN and invalid codes being rejected
- [x] 3.3 Implement the generic `EventEnvelope(payload)` schema and a `createEnvelope()` helper that generates UUIDv7 `eventId` and UTC `occurredAt`; unit tests for missing fields and wrong types
- [x] 3.4 Implement v1 payload schemas for the 7 events in SPEC §4.9 with `eventType`/`eventVersion` constants; unit tests parse every SPEC §4.9 example and reject invalid enums (`decision`, `verdict`, `channel`, `direction`)
- [x] 3.5 Ensure consumer schemas strip unknown fields (no `.strict()`); unit test proves an extra field is accepted and removed (SPEC §4.10)
- [x] 3.6 Export topic names, consumer group names, retry/DLQ name builders and Kafka header names (SPEC §4.1, §4.2, §4.6); unit test asserts the TS topic list equals `infra/kafka/topics.conf`
- [x] 3.7 Add contract fixtures folder (`libs/contracts/fixtures/*.json`, one valid example per event) to be reused by contract tests in later milestones; verify fixtures parse in a unit test
- [x] 3.8 Write `libs/contracts/README.md` describing the envelope, versioning rules (SPEC §4.10) and how to add a field; verify examples in the README compile via a doc test or are copied from tested fixtures

## 4. CI pipeline (SPEC §15)

- [x] 4.1 Create `.github/workflows/ci.yml` triggered on `pull_request` and `push` to `main`, with Node from `.nvmrc`, pnpm cache and `pnpm i --frozen-lockfile`; verify the workflow runs on the M0 PR
- [x] 4.2 Add job `lint-typecheck` (`format:check`, `nx affected -t lint typecheck` on PRs, `run-many` on `main`); verify a deliberate lint error makes the job fail
- [x] 4.3 Add job `unit` (`nx affected -t test --coverage`) uploading the coverage report as an artifact; verify the job passes and the artifact is attached
- [x] 4.4 Add Dependabot config for npm, GitHub Actions and Docker; verify the file validates in the repository insights

## 5. Decision records (SPEC §16)

- [x] 5.1 Add `docs/adr/` index and template; write ADR-002 (co-partitioning by `accountId`, 12 partitions) and a stub ADR-003 (Kafka client choice: evaluation criteria for `@confluentinc/kafka-javascript` vs KafkaJS, decision due in M1); verify both are linked from the index

## 6. Verification

- [x] 6.1 From a clean clone: `pnpm i`, `cp .env.example .env`, `docker compose --profile core up -d`, `scripts/verify-topics.sh` all succeed
- [x] 6.2 Run `pnpm lint && pnpm typecheck && pnpm test` and confirm all pass; confirm CI is green on the PR
- [x] 6.3 Check every M0 acceptance item in SPEC §17 is satisfied and tick it in the PR description

## Workflow follow-up

- Archive the change with `/opsx:archive m0-skeleton` after the PR is merged, so its specs move to `openspec/specs/`.
- Start M1 with `/opsx:apply m1-ingestion-vault-outbox`.
