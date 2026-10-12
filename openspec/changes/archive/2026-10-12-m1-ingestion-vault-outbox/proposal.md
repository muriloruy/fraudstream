# Proposal

## Why

Milestone M1 (SPEC §17) delivers the entry point of the platform: card data is tokenized by an isolated vault, authorization requests are accepted idempotently, and every accepted transaction is published to Kafka exactly once through a transactional outbox. It also proves the most important security property early: a PAN never leaves the vault.

## What Changes

- New service `card-vault` (internal only): tokenize with AES-256-GCM, HMAC dedup lookup, key versioning and `pnpm vault:rotate`, audited restricted detokenize (SPEC §5.2, §6.2).
- New service `transaction-api`: `POST /v1/transactions` and `GET /v1/transactions/:id`, validation, API-key auth, idempotency keys, RFC 9457 errors, rate limiting, health checks (SPEC §6.1, §3.3 steps 1–3).
- `payments` migrations: partitioned `transactions`, `idempotency_keys`, `outbox`, `api_keys` (SPEC §5.1, §4.5).
- New `libs/db` (pool, migration runner, transaction helper), `libs/outbox` (writer + relay core), `libs/security` (redaction, masking, hashing) (SPEC §12).
- New worker `outbox-relay`: `FOR UPDATE SKIP LOCKED` polling, keyed publish with idempotent producer and standard headers (SPEC §4.2, §4.5, §6.3).
- PAN leak test and `pnpm test:security`; integration test with 2 relays and 1,000 events (SPEC §13.2, §7).
- ADR-003 (Kafka client), ADR-004 (outbox), ADR-008 (vault), ADR-009 (money).

Out of scope: the `transaction-api` status consumer of `fraud.decisions.v1` (SPEC §3.3 step 8) — added in M3 once the consumer library (M2) exists. mTLS to the vault (stretch).

## Capabilities

### New Capabilities
- `card-tokenization`: PAN tokenization, encryption at rest, key rotation and controlled detokenization in the vault.
- `transaction-ingestion`: the public authorization API — validation, authentication, idempotency, error format, rate limiting and status lookup.
- `event-publishing`: atomic DB-write-plus-event via transactional outbox and the relay that publishes it to Kafka with ordering and exactly-once publication.
- `cardholder-data-protection`: cross-cutting guarantees that PAN/CVV never appear in logs, Kafka, or tables outside the vault.

### Modified Capabilities
<!-- none -->

## Impact

- New apps `card-vault`, `transaction-api`, `outbox-relay`; libs `db`, `outbox`, `security`, `testing`.
- New migrations under `migrations/payments/` and `migrations/vault/`.
- Compose: adds the three services (vault without published ports).
- Dependencies: NestJS, `pg`, Kysely or `node-pg-migrate`, chosen Kafka client, `decimal.js`, `pino`/`nestjs-pino`, `helmet`, `@nestjs/throttler`, Testcontainers.
