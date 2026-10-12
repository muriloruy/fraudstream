# ADR-003: Kafka client library choice

- **Status:** proposed — decision due in M1, before the first producer is written
- **Date:** 2026-10-12
- **Milestone:** M1 (SPEC §2)

## Context

Every service produces or consumes Kafka. SPEC §2 names two candidates and asks to check their maintenance status before choosing. The client is wrapped by `libs/kafka` (M1 producer, M2 consumer runtime), so the choice must be swappable, but switching later still costs a full re-test of the delivery guarantees.

## Candidates

- **`@confluentinc/kafka-javascript`** — maintained by Confluent, built on librdkafka (native), offers a KafkaJS-compatible API and the librdkafka-style API.
- **KafkaJS** — pure JavaScript, the de facto Node client for years; check whether it still has active maintainers and releases.

## Evaluation criteria

1. **Maintenance:** release cadence, open security issues, support for current Kafka (4.x, KRaft) and Node LTS.
2. **Semantics we rely on:** idempotent producer (`enable.idempotence`, `acks=all`), manual offset commit, `eachBatch` with `resolveOffset`/`heartbeat`, pause/resume per partition (retry topics, SPEC §4.6), rebalance callbacks, `read_committed`, transactions (stretch).
3. **Performance:** publish throughput and p99 latency at 200 and 500 msg/s with `linger.ms=5` and lz4/zstd, measured with a small benchmark against the compose cluster.
4. **Operability:** install on CI and in Alpine/distroless images (native binaries), error messages, logging hooks, OpenTelemetry instrumentation available.

## Decision

To be recorded in M1 with the benchmark results. The working assumption in the M1 design is `@confluentinc/kafka-javascript` through its KafkaJS-compatible API, behind the `libs/kafka` wrapper.

## Consequences

Filled in with the decision.
