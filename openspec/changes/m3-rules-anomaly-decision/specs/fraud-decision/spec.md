# Spec Delta

## Purpose

Combines the rule result and the anomaly score of each transaction into one final, explainable and auditable decision, even when one input is late.

## ADDED Requirements

### Requirement: Join by transaction
The engine SHALL hold partial results per `transactionId` and decide as soon as both the rule result and the anomaly score are present, publishing exactly one `FraudDecisionMade` (SPEC §6.6).

#### Scenario: Both parts arrive
- **WHEN** the rule result and anomaly score for a transaction arrive in any order
- **THEN** one decision is published with `partial = false`

#### Scenario: Duplicate part
- **WHEN** the rule result is delivered twice
- **THEN** only one decision is published

### Requirement: Fusion and thresholds
The engine SHALL compute `finalScore = wRules·ruleScore + wAnomaly·anomalyScore` with `wAnomaly = 0.4` when `baselineSampleSize ≥ 10`, else 0.15; `hardDecline` → `DECLINE`; otherwise `< 0.40` → `APPROVE`, `< 0.75` → `REVIEW`, else `DECLINE`, with thresholds from config.

#### Scenario: Threshold boundary
- **WHEN** `finalScore` is exactly 0.40
- **THEN** the decision is `REVIEW`

#### Scenario: Hard decline overrides
- **WHEN** `hardDecline` is true and `finalScore` is 0.1
- **THEN** the decision is `DECLINE`

### Requirement: Join timeout
If a pending transaction is not complete within the join timeout (default 2 s), the engine SHALL decide with the available part and `partial = true`; if the rule result is missing the decision SHALL be `REVIEW`.

#### Scenario: Anomaly score late
- **WHEN** only the rule result arrives within 2 s
- **THEN** a decision is published with `partial = true` based on the rule score

#### Scenario: Late part after timeout
- **WHEN** the anomaly score arrives after a partial decision was made
- **THEN** no second decision is published

### Requirement: Explainability and auditability
Every decision SHALL include human-readable `reasons`, `components`, `latencyMs` and SHALL be stored with the `config_version` used.

#### Scenario: Reasons listed
- **WHEN** R001 fired and `amountZ` was 4.2
- **THEN** `reasons` contains "R001 velocity_1m" and an amount-deviation reason

### Requirement: Decision metrics
The engine SHALL export `decision_latency_seconds` (histogram) and `decisions_total{decision}`.

#### Scenario: Counter per decision
- **WHEN** a `DECLINE` is published
- **THEN** `decisions_total{decision="DECLINE"}` increases by 1
