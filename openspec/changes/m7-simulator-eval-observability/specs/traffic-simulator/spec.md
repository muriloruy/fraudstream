# Spec Delta

## Purpose

Produces realistic, reproducible payment traffic with labeled fraud patterns so the platform can be demonstrated, load-tested and evaluated without real data.

## ADDED Requirements

### Requirement: Account seeding
`pnpm sim:seed --accounts <n>` SHALL publish `n` account profiles to `accounts.profiles.v1` and generate 30 days of compressed historical baseline traffic.

#### Scenario: Seed 10,000 accounts
- **WHEN** `pnpm sim:seed --accounts 10000` completes
- **THEN** 10,000 distinct account keys exist in the profiles topic and fraud-rules has materialized them

### Requirement: Live traffic generation
`pnpm sim:run --tps <n> --duration <d> --fraud-rate <r>` SHALL send transactions over HTTP to the public API at the target rate, with a unique `Idempotency-Key` per request.

#### Scenario: Target rate
- **WHEN** the simulator runs at 100 tps for 1 minute
- **THEN** about 6,000 requests are sent (±5%) and accepted with 202

### Requirement: Fraud scenarios
The simulator SHALL support `normal`, `card_testing`, `account_takeover`, `impossible_travel` and `merchant_compromise`, each injectable alone with `--scenario <name>`, with behaviors as in SPEC §6.9.

#### Scenario: Card testing only
- **WHEN** the simulator runs with `--scenario card_testing`
- **THEN** it sends bursts of 5–10 transactions of 1.00–4.00 within minutes per targeted account

### Requirement: Ground truth
Every generated transaction SHALL be recorded in `simulator_output/ground_truth.csv` with `transactionId`, `isFraud` and `scenario`.

#### Scenario: Every request labeled
- **WHEN** a run finishes
- **THEN** the CSV has one row per accepted transaction

### Requirement: Test card numbers only
The simulator SHALL use only Luhn-valid test PAN ranges and never real card numbers.

#### Scenario: PAN source
- **WHEN** the simulator's PAN generator output is checked
- **THEN** every PAN belongs to a documented test BIN range and passes Luhn
