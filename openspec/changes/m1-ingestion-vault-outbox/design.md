# Design

## Context

Builds on M0 (monorepo, compose, contracts). See proposal.md for motivation and the specs for required behavior. This milestone introduces the first NestJS services, the DB access layer, and the Kafka producer; the Kafka consumer library is M2.

## Goals / Non-Goals

**Goals:**
- Service layout per SPEC §12: `src/{main.ts, app.module.ts, config/, domain/, application/, infrastructure/{db,http,kafka}}`; domain free of framework imports.
- Shared libs that later services reuse unchanged: `libs/db`, `libs/outbox`, `libs/security`, `libs/testing`.

**Non-Goals:**
- Consumers, retry/DLQ (M2). Status updates from decisions (M3). OTel tracing beyond generating/propagating `traceparent` header values (M7).

## Decisions

- **Kafka client (ADR-003)**: evaluate `@confluentinc/kafka-javascript` (librdkafka, maintained by Confluent, KafkaJS-compatible API) vs KafkaJS (pure JS, unmaintained since 2023). Default choice: `@confluentinc/kafka-javascript` via its KafkaJS-compatible API, wrapped in `libs/kafka` producer so the choice is swappable. Record measured publish throughput.
- **SQL layer**: raw parameterized SQL through `pg` (no query builder) plus `node-pg-migrate` running plain `.sql` migrations with `-- Up/Down Migration` markers, each applied as the service's own role. Kysely was considered; SPEC §2 allows either, and explicit SQL keeps partition DDL, index comments and locking clauses (`FOR UPDATE SKIP LOCKED`) visible. `libs/db` exposes `createPool`, `withTransaction(pool, fn)` and `migrate()`.
- **Partitions**: `payments.transactions` monthly range partitions; migration helper creates current + next 2 months, and a startup check warns if next month is missing. pg_partman considered but avoided to keep the image stock.
- **Idempotency flow**: `INSERT ... ON CONFLICT DO NOTHING` on `idempotency_keys` with `response_status = 0` as an "in progress" marker. `request_hash` is an HMAC (with `HASH_PEPPER`) of the canonical request body, computed in memory before tokenization, so the PAN is never stored nor brute-forceable from the hash. Same key + same hash → stored response; different hash → 422; in progress → 409. Transaction + outbox + final idempotency response are written in one DB transaction.
- **Vault crypto**: Node `crypto` `aes-256-gcm`, keys from `VAULT_DEK_V<n>` (base64, 32 bytes), active version from `VAULT_ACTIVE_KEY_VERSION`; HMAC key `VAULT_HMAC_KEY`. PAN kept in a `Buffer`, zeroed after use. Rotation script streams rows in batches with `FOR UPDATE SKIP LOCKED`.
- **Money**: `decimal.js` in domain, `numeric(18,2)` in DB, decimal strings on the wire (ADR-009).
- **Errors**: global Nest exception filter mapping to RFC 9457; validation via a Zod pipe using contracts' API schemas (keeps one source of truth with the web app).
- **Relay**: generic `libs/outbox` relay core parameterized by schema name, reused by every producing service in M3–M5; one `outbox-relay` app instance per schema configured via env (`RELAY_SCHEMA=payments`). Poll 100 ms, exponential backoff to 2 s when empty, batch 500.
- **Leak test**: `tests/security/pan-leak.spec.ts` with Testcontainers (Postgres + Kafka) + in-process services, captures pino output via a test transport, consumes all topics from the beginning, and greps `pg_dump --exclude-schema=vault`.

## Risks / Trade-offs

- [Idempotency request hash could expose the PAN] → a plain sha256 of a body containing a 16-digit PAN is brute-forceable, so the hash is an HMAC keyed by `HASH_PEPPER`.
- [Relay ordering with SKIP LOCKED and 2 instances] → two relays can publish interleaved batches for the same key; mitigate by having each relay lock a batch and publish it sequentially, and by documenting that strict per-key order needs one active relay per schema or advisory-lock leader election. Integration test asserts order per key with the chosen approach (advisory lock leader, second instance standby).
- [librdkafka native build on CI] → prebuilt binaries; fall back to KafkaJS behind the same wrapper if install fails.

## Migration Plan

New services only; no existing data. Rollback = remove services from compose.

## Open Questions

- Whether `GET /v1/transactions/:id` requires the same API key that created it (tenant scoping) — default yes; does not change tasks.
