# kafka-topics Specification

## Purpose
Defines the Kafka topic catalogue and broker safety settings so that per-account ordering, co-partitioned joins and durable delivery hold for every service.

## Requirements

### Requirement: Explicit topic creation
Every topic in SPEC §4.1 SHALL be created by the topic initializer with explicit partitions, replication factor, cleanup policy and retention, and broker auto-creation SHALL be disabled (`auto.create.topics.enable=false`).

#### Scenario: Catalogue matches the spec
- **WHEN** the core stack has started
- **THEN** `payments.transactions.v1`, `accounts.profiles.v1`, `fraud.rule-results.v1`, `fraud.scores.v1`, `fraud.decisions.v1` and `ledger.entries.v1` exist with 12 partitions and replication factor 3, and `fraud.analyst-feedback.v1` exists with 6 partitions

#### Scenario: Unknown topic is not auto-created
- **WHEN** a client produces to a topic that is not in the catalogue
- **THEN** the broker returns an unknown-topic error and no topic is created

### Requirement: Co-partitioning of fraud topics
All fraud-flow topics keyed by `accountId` SHALL share the same partition count (12) so that one account maps to the same partition number in every topic (SPEC §4.1, ADR-002).

#### Scenario: Same partition count across the join
- **WHEN** the partition counts of `fraud.rule-results.v1` and `fraud.scores.v1` are compared
- **THEN** they are equal to the partition count of `payments.transactions.v1`

### Requirement: Retention and compaction policy
Topics SHALL use the cleanup policy and retention from SPEC §4.1: `accounts.profiles.v1` compacted; transactions 7 days; rule results and scores 3 days; decisions, ledger entries and analyst feedback 30 days.

#### Scenario: Profiles topic is compacted
- **WHEN** the config of `accounts.profiles.v1` is described
- **THEN** `cleanup.policy` is `compact`

#### Scenario: Retention of decisions
- **WHEN** the config of `fraud.decisions.v1` is described
- **THEN** `retention.ms` equals 30 days

### Requirement: Durability settings
In the 3-broker profile the cluster SHALL enforce `min.insync.replicas=2` and `unclean.leader.election.enable=false` (SPEC §4.1).

#### Scenario: Write rejected without enough replicas
- **WHEN** two of three brokers are stopped and a producer with `acks=all` sends a message
- **THEN** the send fails with a not-enough-replicas error instead of being acknowledged

### Requirement: Retry and DLQ topic naming
The topic catalogue SHALL define the naming rule `<topic>.<group>.retry` (1-day retention) and `<topic>.<group>.dlq` (30-day retention) for every consumer group listed in SPEC §4.1, and create those topics at startup.

#### Scenario: DLQ topic exists for each consumer group
- **WHEN** the topic list is fetched after startup
- **THEN** `payments.transactions.v1.fraud-rules.dlq` and `payments.transactions.v1.fraud-rules.retry` exist, and likewise for every other source topic and group pair
