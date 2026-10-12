# ADR-003: Kafka client library choice

- **Status:** accepted
- **Date:** 2026-10-12
- **Milestone:** M1 (SPEC §2)

## Context

Every service produces or consumes Kafka. SPEC §2 names two candidates and asks to check their maintenance status before choosing. The client is wrapped by `libs/kafka` (M1 producer, M2 consumer runtime), so the choice is swappable, but switching later still costs a full re-test of the delivery guarantees.

## Evaluation

| Criterion                                                                                                             | `@confluentinc/kafka-javascript` 1.11.0                                                      | KafkaJS 2.2.4                                         |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Maintenance                                                                                                           | Maintained by Confluent; release on 2026-10-07; librdkafka 2.16                              | Last release 2023-02-27; no maintainer activity since |
| API                                                                                                                   | KafkaJS-compatible API plus native librdkafka API                                            | KafkaJS API                                           |
| Semantics we need (idempotent producer, manual commit, pause/resume, rebalance hooks, `read_committed`, transactions) | All, implemented by librdkafka                                                               | All, in pure JS                                       |
| Compression                                                                                                           | lz4, zstd, snappy, gzip built in                                                             | gzip only without extra codec packages                |
| Install                                                                                                               | Prebuilt native binary (glibc x64/arm64) downloaded on install; falls back to a source build | Pure JS                                               |

**Benchmark** (single broker in Docker on the dev container, 12 partitions, 500-byte messages, `acks=all`, idempotent producer, two runs each):

| Client                                          | Batched throughput (200 × 500 messages, awaited sequentially, like the outbox relay) | Single awaited send, p50 / p99 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| confluent-kafka-javascript (`linger.ms=5`, lz4) | 25,315 / 36,281 msg/s                                                                | 6.4–6.6 ms / 8.1–8.9 ms        |
| KafkaJS (gzip)                                  | 37,914 / 46,441 msg/s                                                                | 1.2–1.3 ms / 4.3–5.1 ms        |

KafkaJS is faster in this micro-benchmark. Most of the single-send latency gap is the 5 ms `linger.ms` we configure on purpose (SPEC §4.2) to batch under load. Both clients exceed the project's target (200 tx/s sustained, 500 tx/s stretch, SPEC §11) by two orders of magnitude, so raw speed does not decide.

## Decision

Use **`@confluentinc/kafka-javascript` through its KafkaJS-compatible API**, wrapped by `libs/kafka` (`createKafka`, `createProducer`). No other module imports the client directly.

The deciding factor is maintenance: KafkaJS has had no release in over three years, so security fixes and Kafka 4.x protocol changes would be on us. librdkafka is the reference client used by most non-JVM Kafka clients, and the compatible API keeps the code readable and the switch cheap if that ever changes.

## Consequences

- Native dependency: `pnpm-workspace.yaml` allows its install script (`onlyBuiltDependencies`), and Docker images must use a glibc base (or build from source on Alpine) — relevant for the M8 images.
- Single-message latency includes up to `linger.ms` (5 ms). Revisit `linger.ms` and `eachMessage` vs `eachBatch` in the M8 load test (SPEC §4.3, §11) and record the results here.
- Producer settings live in one place: `libs/kafka/src/producer.ts` (`acks=all`, idempotence, `max.in.flight=5`, lz4, `linger.ms=5`).
