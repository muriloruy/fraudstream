# ADR-004: Transactional outbox (polling) vs Kafka transactions vs CDC

- **Status:** accepted
- **Date:** 2026-10-12
- **Milestone:** M1 (SPEC §4.5); revisited in the stretch milestone (Kafka transactions, Debezium)

## Context

Every service that changes its database must also publish an event about it. Doing both naively ("dual write") loses events or emits phantom ones: the process can crash between the DB commit and the Kafka send, or the send can succeed while the DB transaction rolls back. The fraud pipeline cannot tolerate either: a lost transaction is never scored, a phantom one is scored but does not exist.

## Decision

**Transactional outbox with a polling relay**, shared by every producing service through `libs/outbox`:

- The service writes its business rows and an `<schema>.outbox` row in **one** PostgreSQL transaction (`OutboxWriter`). The event exists if and only if the change does.
- `outbox-relay` (one deployment per schema) reads `WHERE published_at IS NULL ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED`, publishes with the idempotent producer (`acks=all`), waits for every ack, then sets `published_at` and commits. On failure it records `attempts`/`last_error` and backs off exponentially (100 ms → 2 s).
- **Ordering.** Rows are read in id order and sent with their key, so per-key order holds within one publisher. With several relay instances, `SKIP LOCKED` alone is not enough: two instances could publish consecutive batches of the same key concurrently and the later batch could land first. A session-level advisory lock (`pg_try_advisory_lock(hashtext('outbox-relay:<schema>'))`) therefore elects one active publisher per schema; the others stand by and take over within about a second when the leader's connection drops. The integration test runs two relays over 1,000 events and checks exactly one copy of each `event-id` and increasing sequence numbers per key.
- **Delivery semantics.** At least once: a crash after the acks but before the commit republishes that batch. Consumers deduplicate by `event-id` (SPEC §4.4).
- **Bounded delivery.** The relay sets `message.timeout.ms` (15 s) so a broker outage becomes a failed batch that is retried, instead of a send that hangs.
- **Metrics.** `outbox_lag_rows`, `outbox_oldest_unpublished_seconds` (served by the partial index `WHERE published_at IS NULL`), `outbox_publish_duration_ms`.

## Alternatives considered

- **Kafka transactions (consume-transform-produce, EOS).** Atomic across Kafka topics and offsets, but not across PostgreSQL and Kafka, which is exactly our boundary. Useful later for Kafka-to-Kafka steps; planned as a comparison in the stretch milestone.
- **CDC with Debezium reading the WAL.** No polling, lower latency, no load from `SELECT ... FOR UPDATE`. Costs a Kafka Connect cluster, replication slots to watch (a stuck slot retains WAL indefinitely) and more moving parts in `docker compose`. Planned as a stretch replacement for the relay, keeping the same outbox table.
- **Publish then write (or write then publish) without an outbox.** Dual write; rejected for the failure modes above.

## Consequences

- One extra table and one small process per producing schema; outbox rows should be purged after publication (a cleanup job is added with the consumer library in M2).
- Publication latency is bounded by the poll interval (100 ms when busy) plus the producer linger (5 ms) — acceptable against the 500 ms p95 decision target (SPEC §11), to be measured in M8.
- Throughput of one schema's outbox is bounded by a single active publisher; batching (500 rows, measured at tens of thousands of messages per second in ADR-003) keeps that far above the 200 tx/s target.
