# Spec Delta

## Purpose

Gives every producer and consumer one shared, versioned definition of the event envelope, payloads, topic names and consumer groups, so incompatible messages are caught at the boundary and in CI.

## ADDED Requirements

### Requirement: Common event envelope
Every event SHALL be wrapped in an envelope with `eventId` (UUIDv7), `eventType`, `eventVersion` (integer), `occurredAt` (ISO 8601 UTC), `producer`, `correlationId` (UUID), `causationId` (UUID or null) and `payload` (SPEC §4.8).

#### Scenario: Valid envelope accepted
- **WHEN** an envelope with all fields valid and a valid payload is parsed
- **THEN** parsing succeeds and returns the typed event

#### Scenario: Missing correlation id rejected
- **WHEN** an envelope without `correlationId` is parsed
- **THEN** parsing fails with an error naming the `correlationId` field

### Requirement: v1 payload schemas
The contracts SHALL define v1 payload schemas for `TransactionAuthorizationRequested`, `FraudRulesEvaluated`, `AnomalyScored`, `FraudDecisionMade`, `LedgerEntriesPosted`, `AccountProfileUpserted` and `AnalystFeedbackRecorded` exactly as in SPEC §4.9.

#### Scenario: Spec example parses
- **WHEN** each JSON example from SPEC §4.9 is parsed with its schema
- **THEN** parsing succeeds

#### Scenario: Decision outside the allowed set
- **WHEN** a `FraudDecisionMade` payload with `decision` = `MAYBE` is parsed
- **THEN** parsing fails

### Requirement: Money as decimal strings
Monetary amounts in every contract SHALL be decimal strings with at most 2 decimal places and a 3-letter currency code; numeric (floating point) amounts SHALL be rejected (SPEC §4.9, ADR-009).

#### Scenario: Float amount rejected
- **WHEN** a transaction payload has `amount.value` = `1250.9` as a JSON number
- **THEN** parsing fails

#### Scenario: Three decimals rejected
- **WHEN** a transaction payload has `amount.value` = `"10.123"`
- **THEN** parsing fails

### Requirement: No cardholder secrets in events
Event contracts SHALL NOT contain a field for a full PAN or CVV; card data is carried only as `cardToken` and a 16-character `maskedPan` (first 6 / last 4).

#### Scenario: Masked PAN format enforced
- **WHEN** a transaction payload has `maskedPan` = `4111111111111111`
- **THEN** parsing fails because the middle digits are not masked

### Requirement: Tolerant consumers
Consumer-side schemas SHALL accept and ignore unknown fields so that backward-compatible additions inside v1 never break consumers (SPEC §4.10).

#### Scenario: Extra field ignored
- **WHEN** a consumer parses a v1 payload that contains an extra field `foo`
- **THEN** parsing succeeds and the result has no `foo` field

### Requirement: Canonical topic and group names
Topic names, consumer group names, and event header names (`event-id`, `event-type`, `event-version`, `correlation-id`, `causation-id`, `traceparent`, `producer`) SHALL be exported as constants from the contracts library and match the topic catalogue (SPEC §4.1, §4.2).

#### Scenario: Topic constants match the catalogue
- **WHEN** the contracts test compares exported topic names with the list used by the topic initializer
- **THEN** both lists are identical
