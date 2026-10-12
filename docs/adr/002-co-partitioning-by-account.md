# ADR-002: Co-partitioning by `accountId` with 12 partitions

- **Status:** accepted
- **Date:** 2026-10-12
- **Milestone:** M0 (SPEC §4.1, §17)

## Context

The fraud flow fans a transaction out to two consumers (`fraud-rules`, `anomaly-scorer`) and joins their results in `decision-engine` (SPEC §3.3). Rules and scoring keep per-account state (activity windows, EWMA baselines) and must see an account's transactions in order. The join must be cheap: no cross-instance lookups and no shared cache.

## Decision

Every fraud-flow topic (`payments.transactions.v1`, `accounts.profiles.v1`, `fraud.rule-results.v1`, `fraud.scores.v1`, `fraud.decisions.v1`, `ledger.entries.v1`) is **keyed by `accountId`** and has **exactly 12 partitions**. `fraud.analyst-feedback.v1` (low volume, consumed only by the scorer, which looks the account up by key) has 6.

With the same key, the same partitioner and the same partition count, an account maps to the same partition number in every topic. When `decision-engine` subscribes to both input topics with the **range assignor**, partition _n_ of each topic goes to the same instance, so both halves of a transaction's join arrive at one consumer. The join state lives in `decision.pending` (PostgreSQL), so correctness never depends on this co-location; it removes cross-instance contention on pending rows and keeps per-account processing single-threaded. The consumer library (M2) must therefore configure the range assignor for multi-topic joins: round-robin or sticky assignors do not keep partition numbers together.

The counts live in one place, `libs/contracts/src/topics.ts`; `infra/kafka/topics.conf` is generated from it and a unit test fails if they differ.

## Alternatives considered

- **Key by `transactionId`** — spreads load evenly, but loses per-account ordering, which velocity rules, impossible-travel and EWMA updates depend on.
- **Different partition counts per topic** — breaks co-partitioning; the join would need a shared store or a repartition step.
- **More partitions (e.g. 48) for headroom** — more parallelism ceiling, but more open files, slower rebalances and more under-filled batches on a laptop. 12 allows up to 12 consumer instances per group, far beyond the 3-replica scaling test (SPEC §11).

## Consequences

- `decision-engine` must use the range assignor (M2); a test with 2 instances asserts that partition _n_ of both inputs lands on the same instance.
- Per-account ordering is guaranteed end to end (SPEC §4.7), except for messages rerouted to a retry topic.
- **The partition count is fixed.** Adding partitions changes `hash(key) % n` and silently breaks both ordering and co-partitioning. Changing it requires new `*.v2` topics and a migration (dual publish), like any breaking change (SPEC §4.10).
- **Hot partitions:** an account or merchant burst (the `merchant_compromise` scenario hits many accounts, so it spreads; a single very active account does not) loads one partition. Watch per-partition lag (kafka-exporter, M7) and the load test (M8).
- The scaling ceiling per consumer group is 12 instances.
