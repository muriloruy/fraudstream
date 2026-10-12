# Spec Delta

## Purpose

States the guarantees the platform keeps when brokers or services fail under load, and how fast it recovers, verified by an automated chaos test.

## ADDED Requirements

### Requirement: No loss under single failures
Killing any one broker or any one consumer instance during sustained load SHALL lose no transaction: every accepted transaction SHALL eventually have exactly one decision.

#### Scenario: Broker killed under load
- **WHEN** one of three brokers is killed during a 200 tx/s run and the run completes
- **THEN** the count of decisions equals the count of accepted transactions

### Requirement: No duplicate journals
After any failure and recovery, the ledger SHALL contain exactly one journal per approved decision and balances SHALL net to zero per currency.

#### Scenario: Chaos sequence
- **WHEN** the chaos script kills a broker, then a `fraud-rules` replica, then `ledger`, and the system recovers
- **THEN** reconciliation reports `count(approved decisions) = count(journals)`, zero unbalanced journals, and zero net balance

### Requirement: Backlog recovery
A restarted consumer SHALL catch up a 100k-message backlog in under 2 minutes.

#### Scenario: Backlog drain
- **WHEN** `fraud-rules` is stopped until 100k messages accumulate and then restarted
- **THEN** its consumer lag returns to near zero in under 2 minutes

### Requirement: Horizontal scaling
Running 3 replicas of `fraud-rules` SHALL spread partitions across replicas and increase throughput relative to 1 replica.

#### Scenario: Three replicas
- **WHEN** `fraud-rules` is scaled to 3 replicas
- **THEN** each replica owns 4 of the 12 partitions and measured throughput is higher than with 1 replica
