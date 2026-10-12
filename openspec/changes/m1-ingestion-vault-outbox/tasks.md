# Tasks

## 1. Shared infrastructure libs (SPEC §12)

- [ ] 1.1 Create `libs/db`: per-service pg pool from `DATABASE_URL_<SVC>`, `withTransaction()` helper, migration runner wrapper and root script `pnpm db:migrate`; integration test (Testcontainers) proves rollback on thrown error
- [ ] 1.2 Create `libs/security`: pino redaction paths (SPEC §7), `maskPan()`, `luhnValid()`, `hashWithPepper()` (`sha256:` prefix); unit tests for masking, Luhn table cases and hashing determinism
- [ ] 1.3 Create `libs/observability` minimal logger factory (pino JSON with `service`, `correlationId`) using the redaction config; unit test shows a card object logged as `[Redacted]`
- [ ] 1.4 Create `libs/testing` with Testcontainers fixtures for PostgreSQL (with `init-roles.sql`) and Kafka (topics from `topics.conf`); verify a smoke test starts both
- [ ] 1.5 Write ADR-003 (Kafka client choice with maintenance status and a small throughput benchmark) and implement the `libs/kafka` producer wrapper (`acks=all`, idempotence, lz4/zstd, `linger.ms=5`, standard headers from contracts) (SPEC §4.2); integration test publishes and reads back all 7 headers

## 2. card-vault (SPEC §5.2, §6.2)

- [ ] 2.1 Scaffold NestJS app `apps/card-vault` with the SPEC §12 layout, Zod-validated config (refuses placeholder secrets when `NODE_ENV=production`); verify it boots and `/health/live` returns 200
- [ ] 2.2 Migration `migrations/vault/001_cards.sql` (table from SPEC §5.2) plus `vault.audit_log`; verify `pnpm db:migrate` applies it with the `vault_svc` role
- [ ] 2.3 Domain crypto: AES-256-GCM encrypt/decrypt with random 12-byte IV, HMAC-SHA256 lookup, keyring by version, Buffer zeroing; unit tests for round-trip, unique IVs, tamper detection and wrong-key failure
- [ ] 2.4 `POST /internal/tokenize` with service-token guard and dedup by `pan_hmac`; integration tests for new card, same-card-same-token and 401 without token
- [ ] 2.5 `POST /internal/detokenize` restricted to `vault-admin`, audited allow/deny; integration test asserts 403 for service token and an audit row for each attempt
- [ ] 2.6 `scripts/vault-rotate.ts` + `pnpm vault:rotate` re-encrypting in batches; integration test rotates v1→v2 and verifies tokens unchanged and decryption works
- [ ] 2.7 Add `card-vault` to compose with no published ports, internal network only; verify `curl localhost:<port>` from host fails while `transaction-api` container can reach it
- [ ] 2.8 Write ADR-008 (vault design: scope reduction, HMAC lookup, key versioning)

## 3. transaction-api ingestion (SPEC §3.3, §5.1, §6.1)

- [ ] 3.1 Migrations `migrations/payments/`: partitioned `transactions` with monthly partitions helper, indexes with query comments, `idempotency_keys`, `outbox` (SPEC §4.5), `api_keys` (hashed); verify `\d+ payments.transactions` shows partitions and indexes
- [ ] 3.2 Scaffold `apps/transaction-api` (helmet, CORS allow-list, 16 KB body limit, RFC 9457 exception filter, pino with redaction); unit test of the filter output shape and absence of stack traces
- [ ] 3.3 Request schema + Zod validation pipe (unknown fields rejected, Luhn, CVV, amount, currency, country, MCC); table-driven unit tests for each rule and boundary (1,000,000.00 ok, 1,000,000.01 rejected)
- [ ] 3.4 API-key guard against hashed keys + seed script for a demo key; integration test for 401 on missing/invalid key
- [ ] 3.5 Vault client with timeout and 503 mapping; CVV dropped after simulated check; unit test that the CVV/PAN are not kept on the domain object
- [ ] 3.6 Application service: idempotency flow (stored response / 409 / 422), transaction + outbox `TransactionAuthorizationRequested` + idempotency response in one DB transaction, IP/device hashing with pepper; integration tests for replay, 422, 409 and rollback leaving no rows
- [ ] 3.7 `GET /v1/transactions/:id` and `/health/live`, `/health/ready` (DB + Kafka metadata); integration tests for 200, 404 and readiness 503 with DB down
- [ ] 3.8 Rate limiting with `@nestjs/throttler` keyed by API key (100/min POST); integration test for 429 on the 101st request
- [ ] 3.9 Add `transaction-api` to compose with port and env; verify a `curl` POST from the README returns 202
- [ ] 3.10 Write ADR-009 (money representation)

## 4. outbox-relay (SPEC §4.5, §6.3)

- [ ] 4.1 Implement `libs/outbox` writer (insert envelope row with headers) and relay core (`FOR UPDATE SKIP LOCKED` batch, publish, mark published, attempts/last_error, backoff, leader/advisory lock per schema); unit tests for batch state transitions
- [ ] 4.2 Create `apps/outbox-relay` (configured by `RELAY_SCHEMA`, `RELAY_BATCH_SIZE`, `RELAY_POLL_MS`), graceful shutdown on SIGTERM, Prometheus metrics `outbox_lag_rows`, `outbox_oldest_unpublished_seconds`, `outbox_publish_duration_ms`; verify `/metrics` exposes them
- [ ] 4.3 Integration test: 2 relay instances, 1,000 events across many keys → exactly-once publish (unique `event-id` count = 1,000) and per-key order (SPEC §13.2); verify it passes in CI
- [ ] 4.4 Integration test: broker stopped during relay → rows stay unpublished with `attempts` > 0, then published after restart
- [ ] 4.5 Add relay to compose; verify an accepted transaction appears on `payments.transactions.v1` in kafka-ui keyed by `accountId`
- [ ] 4.6 Write ADR-004 (polling outbox vs Kafka transactions vs CDC)

## 5. Security tests (SPEC §7, §13.5)

- [ ] 5.1 Implement `tests/security/pan-leak.spec.ts` and root script `pnpm test:security` (logs, all topics, `pg_dump` excluding `vault`, API responses); verify it fails if redaction is disabled and passes otherwise
- [ ] 5.2 Add SQL-injection payload cases on all string inputs of `POST /v1/transactions` → 400 and DB untouched
- [ ] 5.3 Add CI job `integration` (Testcontainers) running integration + security suites; verify it runs on the PR

## 6. Verification

- [ ] 6.1 End-to-end smoke with compose: POST a transaction → 202, row in `payments.transactions`, event on `payments.transactions.v1` with masked PAN and token only
- [ ] 6.2 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:security`; confirm CI green
- [ ] 6.3 Tick every M1 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m1-ingestion-vault-outbox` after merge.
