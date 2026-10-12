# Proposal

## Why

Kafka delivers at least once; every downstream service (M3–M5) needs the same guarantees — no duplicate side effects, no lost messages, no partition blocked by a poison message, clean shutdown and rebalances. Milestone M2 (SPEC §17) builds them once in `libs/kafka` so services only write business handlers.

## What Changes

- `libs/kafka` consumer runtime: manual offset commit after DB commit, idempotent handler with `processed_events` inbox, in-process retry with backoff, retry topic with `retry-count`/`retry-after`, DLQ with diagnostic headers, rebalance logging, graceful SIGTERM shutdown, W3C `traceparent` propagation (SPEC §4.3, §4.4, §4.6).
- Reusable migration template for `<schema>.processed_events` and a purge job (SPEC §4.4).
- `pnpm dlq:replay` CLI (`--topic --from --to --dry-run`) (SPEC §4.6).
- Consumer metrics `kafka_consumer_messages_total{outcome}` and `kafka_consumer_processing_seconds` (SPEC §10).
- Integration tests from SPEC §13.2 (idempotency, retry, DLQ, rebalance).

Out of scope: the admin DLQ replay endpoint (M5, alerts-gateway) and full OTel SDK/Jaeger (M7); here only the header propagation API.

## Capabilities

### New Capabilities
- `event-consumption`: at-least-once delivery turned into effectively-once processing — commit discipline, idempotency, retries, rebalances and shutdown.
- `dead-letter-handling`: routing permanently failing messages to DLQ with diagnostics, and safely replaying them.

### Modified Capabilities
<!-- none -->

## Impact

- `libs/kafka` (consumer side), `migrations/_templates/processed_events.sql`, `scripts/dlq-replay.ts`, root script `dlq:replay`.
- Every consumer service from M3 onward depends on this API.
