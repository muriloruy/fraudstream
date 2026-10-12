# Spec Delta

## Purpose

Defines how every FraudStream consumer processes Kafka messages so that side effects happen effectively once, nothing is lost, and failures or rebalances never corrupt state.

## ADDED Requirements

### Requirement: Commit only after side effects
Consumers SHALL disable auto-commit and commit a message's offset only after the database transaction containing its side effects has committed (SPEC §4.3).

#### Scenario: Crash before DB commit
- **WHEN** the consumer process is killed after receiving a message but before its DB transaction commits
- **THEN** after restart the message is processed again and its side effect exists exactly once

### Requirement: Idempotent processing
Each consumer SHALL record `(consumer_group, event_id)` in its schema's `processed_events` table in the same DB transaction as its side effects, and skip side effects for an already-recorded event (SPEC §4.4).

#### Scenario: Same event delivered three times
- **WHEN** the same event is delivered 3 times
- **THEN** exactly one side effect exists and the duplicates are counted with outcome `duplicate`

### Requirement: Transient error retry
Transient errors SHALL be retried in process 3 times with exponential backoff (100 ms, 400 ms, 1.6 s); if still failing, the message SHALL be published to `<topic>.<group>.retry` with `retry-count` and `retry-after` headers and reprocessed after `retry-after`, up to 5 retries, after which it goes to the DLQ (SPEC §4.6).

#### Scenario: Transient DB failure recovers
- **WHEN** the DB fails on the first attempt and succeeds on the second
- **THEN** the message is processed once and its offset is committed once

#### Scenario: Retry exhausted
- **WHEN** a message fails transiently on every attempt, including 5 retry-topic rounds
- **THEN** it is published to the DLQ and the source partition continues

### Requirement: Rebalance safety
Consumers SHALL log partition assignment and revocation, and finish or abandon in-flight work on revoke without committing offsets for unfinished messages (SPEC §4.3).

#### Scenario: One of two consumers stops mid-stream
- **WHEN** two consumers share a group and one is stopped while processing
- **THEN** all messages are processed with no loss and no duplicate side effects

### Requirement: Graceful shutdown
On SIGTERM a consumer SHALL stop fetching, finish the in-flight message, commit its offset, and disconnect.

#### Scenario: SIGTERM during processing
- **WHEN** SIGTERM arrives while a message is being handled
- **THEN** the message completes, its offset is committed, and the process exits 0

### Requirement: Trace and correlation propagation
Consumers SHALL extract `traceparent` and `correlation-id` from headers into the processing context and inject them, with `causation-id` set to the consumed `event-id`, into every event they produce (SPEC §4.2, §10).

#### Scenario: Causation chain
- **WHEN** a consumer produces an event while handling event E
- **THEN** the produced event's `causationId` equals E's `eventId` and `correlationId` is unchanged

### Requirement: Consumer metrics
Consumers SHALL expose `kafka_consumer_messages_total` labeled by topic, group and outcome (`ok|duplicate|retry|dlq`) and `kafka_consumer_processing_seconds`.

#### Scenario: Outcome counted
- **WHEN** a duplicate event is skipped
- **THEN** the `duplicate` outcome counter increases by 1

### Requirement: Inbox retention
`processed_events` rows older than the source topic retention plus one day SHALL be purged by a scheduled job.

#### Scenario: Old rows purged
- **WHEN** the purge job runs with a row older than retention + 1 day
- **THEN** that row is deleted and newer rows remain
