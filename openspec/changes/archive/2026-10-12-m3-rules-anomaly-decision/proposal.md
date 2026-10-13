# Proposal

## Why

This is the core of the product: each transaction must be evaluated by deterministic rules and a per-account anomaly score, and the two must be fused into one explainable decision within the latency budget. Milestone M3 (SPEC §17) completes the Kafka must-have (co-partitioned join, consumer groups in parallel) and makes the platform demonstrable end to end.

## What Changes

- New service `fraud-rules`: R001–R010 as pure functions, `rules.yaml` ruleset, single-roundtrip context query, materialized account profiles from the compacted topic (SPEC §5.3, §6.4).
- New service `anomaly-scorer`: per-account EWMA baseline, z-score features, logistic score, cold start, analyst feedback handling (SPEC §5.4, §6.5).
- New service `decision-engine`: join by `transactionId`, timeout sweeper, fusion with configurable thresholds and `config_version` (SPEC §5.5, §6.6).
- `transaction-api` status consumer of `fraud.decisions.v1` updating `payments.transactions` (SPEC §3.3 step 8).
- Decision latency histogram and `decisions_total` metrics (SPEC §10).
- E2E test: `card_testing` → `DECLINE` in < 3 s (SPEC §13.4).
- ADR-005 (asynchronous decision).

Out of scope: simulator scenarios and precision/recall evaluation (M7) — M3 uses a minimal test producer; LSTM scorer (stretch).

## Capabilities

### New Capabilities
- `fraud-rules`: deterministic rule evaluation per transaction with per-account context and an explainable rule score.
- `anomaly-scoring`: statistical per-account anomaly score with baseline learning and feedback.
- `fraud-decision`: joining rule and anomaly results into a final, auditable APPROVE/REVIEW/DECLINE decision, including timeouts.
- `transaction-status`: reflecting the final decision on the transaction exposed by the public API.

### Modified Capabilities
<!-- `transaction-ingestion` (M1) is unchanged; status lookup gets real values through the new `transaction-status` capability. -->

## Impact

- New apps `fraud-rules`, `anomaly-scorer`, `decision-engine`; consumer added inside `transaction-api`.
- Migrations under `migrations/fraud_rules/`, `migrations/anomaly/`, `migrations/decision/`, and a `processed_events` table in `payments`.
- Relay instances for the `fraud_rules`, `anomaly` and `decision` outboxes.
- Env: `DECISION_APPROVE_BELOW`, `DECISION_DECLINE_FROM`, `DECISION_JOIN_TIMEOUT_MS`, `ANOMALY_ALPHA`.
