# Design

## Context

M1 delivered the producer wrapper, `libs/db` and `libs/outbox`. See proposal.md for motivation; behavior is in the specs. Consumers in M3–M5 will call one API, e.g. `runConsumer({ group, topics, schema, handler: (event, tx) => ... })`, where `tx` is the open DB transaction.

## Goals / Non-Goals

**Goals:** a small, framework-agnostic consumer runtime with a NestJS module wrapper; deterministic behavior testable with Testcontainers.

**Non-Goals:** Kafka transactions / EOS (stretch, ADR-004); Schema Registry (stretch).

## Decisions

- **Processing model**: `eachMessage` in v1 for simplicity (single in-flight message per partition preserves per-key order); `eachBatch` with `resolveOffset` + `heartbeat` behind a flag to benchmark in M8 (SPEC §4.3).
- **Handler contract**: runtime opens the DB transaction, inserts into `processed_events ... ON CONFLICT DO NOTHING RETURNING`, calls the handler only when a row is returned, writes outgoing events through the outbox writer within the same `tx`, commits, then commits the offset (`offset + 1`).
- **Error classification**: `TransientError` (connection, timeout, serialization failure `40001`, deadlock `40P01`) vs `PermanentError` (Zod failure, unknown `event-version`, invariant). Unknown errors default to transient so they eventually reach the DLQ via retry exhaustion instead of being dropped.
- **Retry topic consumer**: same group consumes `<topic>.<group>.retry`; if `retry-after` is in the future it pauses that partition and resumes after the delay (no busy loop, no sleeping while holding the session). Per-account ordering is broken for retried messages; documented in README per SPEC §4.7.
- **DLQ publish** uses the idempotent producer directly (not the outbox), since it carries no DB side effect; the offset is committed only after the DLQ ack.
- **Shutdown**: `SIGTERM` → `consumer.pause(all)`, await in-flight promise, commit, `disconnect()`; Nest `enableShutdownHooks()`.
- **Tracing**: header helpers in `libs/kafka/tracing.ts` built on `@opentelemetry/api` propagation; real exporter wired in M7.
- **Replay CLI** reads DLQ by explicit offsets per partition with a dedicated, non-committing consumer; strips `dlq-*` headers and adds `replayed-at`.

## Risks / Trade-offs

- [Retry topic breaks per-key order] → acceptable (SPEC §4.7); alternative "pause partition and retry in place" documented.
- [`processed_events` growth] → purge job + index on `processed_at`.
- [Long DB transactions exceeding `max.poll.interval.ms`] → keep handlers short; set interval to 5 min; metric on processing time.
