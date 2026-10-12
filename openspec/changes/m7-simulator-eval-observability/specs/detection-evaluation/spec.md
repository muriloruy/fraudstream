# Spec Delta

## Purpose

Quantifies how well the fraud pipeline detects each attack scenario and how much legitimate traffic it disturbs, so tuning is evidence-based.

## ADDED Requirements

### Requirement: Evaluation report
`pnpm eval` SHALL join the ground truth with stored decisions and output, per scenario, precision, recall, F1, review rate, decline rate, and the false positive rate (REVIEW + DECLINE) on `normal` traffic (SPEC §9.1).

#### Scenario: Report produced
- **WHEN** `pnpm eval` runs after a simulator run
- **THEN** it prints a table with one row per scenario and writes it to `docs/model.md` under the model version

#### Scenario: Missing decisions
- **WHEN** some ground-truth transactions have no decision yet
- **THEN** the report counts and lists them separately instead of treating them as negatives

### Requirement: Detection targets
On simulator data, recall SHALL be ≥ 0.90 for `card_testing` and `impossible_travel`, ≥ 0.70 for `account_takeover`, and the false positive rate on `normal` SHALL be ≤ 3% (SPEC §9.2).

#### Scenario: Targets met
- **WHEN** the reference run (`--tps 100 --duration 5m --fraud-rate 0.02`) is evaluated
- **THEN** all four targets are met
