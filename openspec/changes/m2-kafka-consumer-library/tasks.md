# Tasks

## 1. Consumer runtime core (SPEC §4.3, §4.4)

- [x] 1.1 Add `migrations/_templates/processed_events.sql` (SPEC §4.4) with `processed_at` index and a helper to include it in each service's migrations; verify it applies in a test schema
- [x] 1.2 Implement consumer factory (`enable.auto.commit=false`, `session.timeout.ms=30000`, `max.poll.interval.ms`, `isolation.level=read_committed`) and `eachMessage` loop committing `offset+1` after handler success; integration test proves offset not committed when handler throws
- [x] 1.3 Implement idempotent handler wrapper (inbox insert + handler + outbox in one DB transaction); integration test delivers the same event 3 times → one side effect (SPEC §13.2)
- [x] 1.4 Implement envelope/header parsing with contracts and error classification (`TransientError`/`PermanentError`); unit tests classify Zod errors, unknown versions and pg error codes
- [x] 1.5 Make the partition assignor configurable and default multi-topic join consumers to the range assignor (ADR-002); integration test with 2 instances subscribed to two co-partitioned topics asserts partition N of both topics lands on the same instance
- [x] 1.6 Implement context propagation (`traceparent`, `correlation-id`, `causation-id`) for produced events; unit test verifies the causation chain

## 2. Retry and DLQ (SPEC §4.6)

- [x] 2.1 In-process retry with backoff 100/400/1600 ms; unit test with fake timers
- [x] 2.2 Retry topic publish with `retry-count`/`retry-after` and retry consumer that pauses/resumes partitions until due, max 5 rounds; integration test: transient failure recovers on retry and offset committed once
- [x] 2.3 DLQ publish with original key/payload/headers + diagnostic headers; integration test: invalid payload lands in DLQ with all headers and the partition keeps flowing
- [x] 2.4 `scripts/dlq-replay.ts` + `pnpm dlq:replay` (`--topic --from --to --dry-run`); integration test: dry run publishes nothing, replaying twice yields one side effect
- [x] 2.5 Document DLQ handling and replay in `docs/runbook.md`; verify the documented command works against the compose stack

## 3. Lifecycle, rebalances and metrics (SPEC §4.3, §10)

- [x] 3.1 Rebalance listeners logging assignment/revocation and draining in-flight work on revoke; integration test: 2 consumers, stop one mid-stream → no loss, no duplicate side effects (SPEC §13.2)
- [x] 3.2 Graceful shutdown on SIGTERM (pause, finish in-flight, commit, disconnect); integration test sends SIGTERM to a child process and checks exit 0 and committed offset
- [x] 3.3 Prometheus metrics `kafka_consumer_messages_total{topic,group,outcome}` and `kafka_consumer_processing_seconds`; unit test checks counters per outcome
- [x] 3.4 Scheduled purge of `processed_events` older than retention + 1 day; integration test with backdated rows
- [x] 3.5 NestJS module wrapper (`KafkaConsumerModule.forFeature(...)`) with shutdown hooks; verify with a sample consumer app in `libs/kafka/examples`

## 4. Documentation

- [x] 4.1 Write `libs/kafka/README.md` (usage, guarantees, ordering caveats from SPEC §4.7) and ADR-007 (PostgreSQL for consumer state vs Redis vs Kafka Streams); verify links from the ADR index

## 5. Verification

- [ ] 5.1 Run all SPEC §13.2 integration tests (idempotency, retry, DLQ, rebalance) in the CI `integration` job; confirm green
- [ ] 5.2 Run `pnpm lint && pnpm typecheck && pnpm test`; tick every M2 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m2-kafka-consumer-library` after merge.
