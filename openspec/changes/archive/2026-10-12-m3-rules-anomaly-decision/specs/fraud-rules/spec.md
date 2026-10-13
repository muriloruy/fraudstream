# Spec Delta

## Purpose

Evaluates every transaction against a versioned set of deterministic fraud rules using the account's recent activity and profile, producing an explainable rule score and hard-decline flag.

## ADDED Requirements

### Requirement: Rule evaluation output
For each `TransactionAuthorizationRequested`, the service SHALL publish exactly one `FraudRulesEvaluated` keyed by `accountId` with `ruleScore = min(1, sum(points)/100)`, `hardDecline`, `firedRules` with details, and `rulesetVersion` (SPEC §4.9, §6.4).

#### Scenario: No rule fires
- **WHEN** a normal transaction at a known merchant in the home country is evaluated
- **THEN** `ruleScore` is 0, `firedRules` is empty and `hardDecline` is false

#### Scenario: Score capped at 1
- **WHEN** fired rules sum to 150 points
- **THEN** `ruleScore` is 1

### Requirement: Velocity rules
R001 SHALL fire when the account has more than 5 transactions in the last 60 s (30 points); R002 SHALL fire when the sum of amounts in the last hour exceeds 50% of the credit limit (25 points).

#### Scenario: Exactly 5 vs 6 transactions
- **WHEN** the current transaction is the 6th within 60 s
- **THEN** R001 fires, and it does not fire for the 5th

### Requirement: Amount rules
R003 SHALL fire when amount > 5 × the 30-day average with at least 10 past transactions (25); R007 when the merchant is new for the account and amount > 2,000 (20); R009 when local hour is 00:00–05:00 and amount > 3 × average (15).

#### Scenario: Insufficient history
- **WHEN** the account has 9 past transactions and amount is 10 × average
- **THEN** R003 does not fire

### Requirement: Location rules
R004 SHALL fire when the previous transaction was in another country and the haversine distance over elapsed time implies more than 900 km/h (40); R005 when merchant country differs from home country (10).

#### Scenario: São Paulo then Lisbon in 30 minutes
- **WHEN** a transaction in Lisbon follows one in São Paulo 30 minutes earlier
- **THEN** R004 and R005 fire

### Requirement: Hard-decline rules
R006 card testing (≥ 3 transactions below 5.00 in 10 min, 50), R008 blocklisted merchant/MCC/BIN (100) and R010 amount over available credit (100) SHALL set `hardDecline = true`.

#### Scenario: Card testing burst
- **WHEN** the 3rd transaction under 5.00 within 10 minutes is evaluated
- **THEN** R006 fires and `hardDecline` is true

#### Scenario: Blocklisted MCC
- **WHEN** the merchant MCC is on the blocklist
- **THEN** R008 fires and `hardDecline` is true

### Requirement: Account profiles from compacted topic
The service SHALL materialize account profiles from `accounts.profiles.v1`, applying upserts and deleting on tombstones.

#### Scenario: Tombstone
- **WHEN** a null value arrives for an account key
- **THEN** that account's profile is removed

### Requirement: Activity recorded after evaluation
After evaluating, the transaction SHALL be added to the account's activity window and known merchants in the same DB transaction as the result event, and activity older than 30 days SHALL be removed by a cleanup job.

#### Scenario: Redelivered transaction
- **WHEN** the same transaction event is delivered twice
- **THEN** it appears once in the activity window and one result is published
