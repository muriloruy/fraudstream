# Spec Delta

## Purpose

Defines the measured performance targets of the platform and the evidence that critical queries remain fast at scale.

## ADDED Requirements

### Requirement: Throughput and latency targets
On a laptop with 3 brokers and all services in Docker, the system SHALL sustain 200 tx/s for 10 minutes with end-to-end decision latency p95 < 500 ms and p99 < 1 s (SPEC §11).

#### Scenario: k6 sustained run
- **WHEN** the k6 script holds 200 tx/s for 10 minutes
- **THEN** the run has < 1% HTTP errors and `decision_latency_seconds` p95 < 0.5 and p99 < 1

### Requirement: Query performance at scale
With 10M+ seeded rows, the alert queue, account history and velocity window queries SHALL use their intended indexes, with before/after `EXPLAIN (ANALYZE, BUFFERS)` documented.

#### Scenario: Velocity window query
- **WHEN** the velocity window query runs on 10M+ `account_activity` rows
- **THEN** the plan is an index range scan on the primary key and the documented execution time is below 5 ms

#### Scenario: Alert queue query
- **WHEN** the first page of the alert queue is fetched with 10M+ alerts of which a fraction are open
- **THEN** the plan uses the partial queue index without a sort node
