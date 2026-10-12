# Design

## Context

M1 provides ingestion + outbox, M2 the consumer runtime. See proposal.md for motivation and specs for behavior. All three new services follow the SPEC §12 layout with pure domain modules.

## Goals / Non-Goals

**Goals:** pure, table-testable domain (`rules/`, `scoring/`, `fusion/`); one SQL round trip for rule context; join local to one consumer thanks to co-partitioning (ADR-002).

**Non-Goals:** rule hot reload (restart in v1); ML models; tuning to the SPEC §9.2 targets (M7).

## Decisions

- **Rules as pure functions** `(tx, ctx) => RuleHit | null`; `rules.yaml` provides ids, points, thresholds and `rulesetVersion`, validated by Zod at boot. Money comparisons with `decimal.js`.
- **Single round-trip context**: one CTE query returns count 60 s, count/sum < 5.00 in 10 min, sum 1 h, 30-day avg/count, last tx (country, lat/lon, time), known-merchant flag, blocklist hits, profile. Documented in `docs/perf.md` (benchmarked in M8).
- **Local hour** for R009 derived from merchant country default timezone map (approximation, documented).
- **Profiles** consumed by a separate consumer in the `fraud-rules` group reading `accounts.profiles.v1` from the earliest offset; missing profile → defaults (`riskTier` MEDIUM, limit from config) and a metric.
- **Anomaly math** in `scoring/ewma.ts` using `double precision`; baseline row locked `FOR UPDATE`; contention negligible because the key routes an account to one consumer.
- **Feedback strategy**: keep the last 50 per-transaction contributions (`anomaly.contributions`) to allow reverting a confirmed-fraud transaction; chosen over "skip updates while alert open" because it does not need alert state in the scorer. Recorded in `docs/model.md`.
- **Join store**: `decision.pending` upsert with `jsonb` parts; decision row, pending delete and outbox insert in one transaction. Sweeper every 250 ms with `FOR UPDATE SKIP LOCKED` so multiple instances are safe; a late part finds a row in `decision.decisions` and is ignored.
- **Config version**: hash of thresholds + weights (`DECISION_*` env) stored as `config_version`.
- **transaction-api status consumer** in group `transaction-api-status`, using the M2 runtime; updates `payments.transactions` by `transaction_id`. Since the table is partitioned by `requested_at`, a btree index on `transaction_id` exists per partition; partition pruning is not possible without the key, which is acceptable at v1 volumes and measured in M8.

## Risks / Trade-offs

- [Partial decisions under load] → monitor `partial` ratio; tune `DECISION_JOIN_TIMEOUT_MS`.
- [Updating partitioned table by id without partition key scans all partitions] → add `UNIQUE`-less btree index on `transaction_id` per partition; acceptable for v1, measured in M8.
- [Timezone approximation for R009] → documented limitation.

## Open Questions

- Population defaults per `riskTier` for cold start — initial values set in config, tuned in M7 with the simulator.
