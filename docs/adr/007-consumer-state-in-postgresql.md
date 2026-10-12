# ADR-007: PostgreSQL for consumer state vs Redis vs Kafka Streams / ksqlDB

- **Status:** accepted
- **Date:** 2026-10-12
- **Milestone:** M2 (SPEC §4.4); state-heavy consumers arrive in M3

## Context

Consumers keep state: the idempotency inbox (`processed_events`), sliding windows for velocity rules, EWMA baselines per account, the pending join in `decision-engine`, ledger balances. Kafka delivers at least once, so every state change must happen exactly once per event even across crashes, rebalances and replays.

## Decision

Keep consumer state in **PostgreSQL, in the consuming service's own schema**, and update it in the **same transaction** as the inbox insert and the outbox write (`libs/kafka` consumer runtime). The Kafka offset is committed after that transaction commits.

This gives effectively-once processing with one simple argument: the event's effects, the record that it was processed, and the events it produces are a single atomic unit. Redelivery after a crash finds the inbox row and does nothing.

Because fraud-flow topics are keyed by `accountId` (ADR-002), one instance owns an account at a time, so row locks on per-account state (`SELECT ... FOR UPDATE`) see almost no contention.

## Alternatives considered

- **Redis for windows and baselines.** Fast, but its writes are not atomic with the PostgreSQL inbox and outbox. We would need a second idempotency mechanism or accept double-counting after a crash. Also another stateful system to run and back up. Kept as an optional cache (SPEC §2).
- **Kafka Streams / ksqlDB.** Exactly-once within Kafka (state stores + changelog topics + transactions) and natural windowing. But it is JVM-only (our services are Node), state lives in RocksDB + changelog topics rather than queryable SQL, and the side effects we need (ledger rows, alerts, API status) live in PostgreSQL anyway, outside its transactional boundary.
- **Kafka transactions in Node (consume-transform-produce).** Atomic between input offsets and output topics only; still not atomic with database writes. Evaluated as a stretch goal in ADR-004.

## Consequences

- Every consumer service needs `processed_events` (`pnpm migrations:add-inbox <service>`) and a purge job (built into the runtime).
- Throughput per partition is bounded by one DB transaction per message; batching (`eachBatch`) is the lever if M8 measurements require it.
- State is inspectable with SQL and covered by the same backups, migrations and least-privilege roles as everything else (SPEC §5).
- Replays (DLQ, reprocessing a topic) are safe by construction.
