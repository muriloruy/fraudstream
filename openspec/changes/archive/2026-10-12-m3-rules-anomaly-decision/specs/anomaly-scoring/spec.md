# Spec Delta

## Purpose

Learns a statistical baseline of each account's behavior and scores how unusual each new transaction is, independent of the deterministic rules.

## ADDED Requirements

### Requirement: Anomaly score output
For each transaction the service SHALL publish one `AnomalyScored` with `anomalyScore` in [0,1], features `amountZ`, `interArrivalZ`, `hourOfDayDeviation`, `newMerchant`, plus `baselineSampleSize` and `modelVersion` (SPEC §4.9).

#### Scenario: Score range
- **WHEN** any transaction is scored
- **THEN** `anomalyScore` is between 0 and 1 inclusive

### Requirement: EWMA scoring
Scores SHALL be computed with the EWMA mean/variance and z-score formulas and the logistic score of SPEC §6.5 using α from config (default 0.1), with z-scores computed against the baseline before the current transaction.

#### Scenario: Reference implementation
- **WHEN** a fixed sequence of amounts and timestamps is scored
- **THEN** each z-score and score matches the reference implementation within 1e-9

#### Scenario: Large amount spike
- **WHEN** an account with a stable baseline receives an amount 4σ above its log-amount mean
- **THEN** `amountZ` is about 4 and `anomalyScore` exceeds 0.5

### Requirement: Baseline update after scoring
The baseline SHALL be updated after scoring, idempotently, once per transaction.

#### Scenario: Duplicate delivery
- **WHEN** the same transaction is delivered twice
- **THEN** the baseline sample size increases by 1

### Requirement: Cold start
When the account has fewer than 10 transactions, the score SHALL use population defaults by `riskTier` and report the actual `baselineSampleSize`.

#### Scenario: New account
- **WHEN** the first transaction of a new account is scored
- **THEN** `baselineSampleSize` is 0 and the score is derived from the risk-tier defaults

### Requirement: Analyst feedback
On `AnalystFeedbackRecorded` with `CONFIRMED_FRAUD` the transaction's contribution SHALL be excluded from the baseline; with `LEGITIMATE` the baseline SHALL be kept or updated as legitimate behavior (SPEC §3.3 step 9, §6.5).

#### Scenario: Confirmed fraud excluded
- **WHEN** a transaction is confirmed as fraud
- **THEN** the account baseline equals the baseline computed without that transaction
