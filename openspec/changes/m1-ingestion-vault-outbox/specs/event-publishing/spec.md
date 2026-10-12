# Spec Delta

## Purpose

Guarantees that a state change in a service's database and the event announcing it are atomic, and that every such event reaches Kafka exactly once and in per-key order.

## ADDED Requirements

### Requirement: Atomic write with outbox
A service SHALL write its business rows and the outgoing event row into its own outbox table in one database transaction, so either both exist or neither does (SPEC §4.5).

#### Scenario: Rollback removes the event
- **WHEN** the transaction insert fails after the outbox insert in the same DB transaction
- **THEN** neither the transaction row nor the outbox row exists

### Requirement: Relay publishes each event exactly once
The relay SHALL read unpublished rows ordered by id with `FOR UPDATE SKIP LOCKED`, publish them keyed by `message_key`, and mark them published only after broker acknowledgement; multiple relay instances SHALL be safe to run concurrently.

#### Scenario: Two relays, no duplicates
- **WHEN** two relay instances process 1,000 outbox rows concurrently
- **THEN** exactly 1,000 messages are on the topic, each `event-id` appears once, and every row has `published_at` set

#### Scenario: Per-key order preserved
- **WHEN** several events share the same `accountId` key
- **THEN** they appear on the partition in outbox id order

### Requirement: Publish failures are retried
If publishing fails, the relay SHALL leave rows unpublished, increment `attempts`, record `last_error`, and retry with backoff.

#### Scenario: Broker unavailable
- **WHEN** Kafka is down during a relay cycle
- **THEN** rows remain with `published_at` null and are published once Kafka recovers

### Requirement: Durable producer and standard headers
Published messages SHALL use `acks=all` with idempotence enabled, and carry headers `event-id`, `event-type`, `event-version`, `correlation-id`, `causation-id`, `traceparent` and `producer` (SPEC §4.2).

#### Scenario: Headers present
- **WHEN** a message published by the relay is inspected
- **THEN** all seven headers are present and `event-id` equals the envelope `eventId`

### Requirement: Relay metrics
The relay SHALL expose `outbox_lag_rows`, `outbox_oldest_unpublished_seconds` and `outbox_publish_duration_ms` (SPEC §6.3).

#### Scenario: Lag visible
- **WHEN** 100 rows are unpublished
- **THEN** `/metrics` reports `outbox_lag_rows` equal to 100
