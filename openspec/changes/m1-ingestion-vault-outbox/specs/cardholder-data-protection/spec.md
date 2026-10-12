# Spec Delta

## Purpose

Cross-cutting guarantee, verified by automated tests, that full card numbers and CVVs never leak outside the vault through logs, events, databases or API responses.

## ADDED Requirements

### Requirement: PAN and CVV never leave the vault
A PAN or CVV SHALL NOT appear in any log line, Kafka message, API response, or database table outside the `vault` schema (SPEC §7).

#### Scenario: Leak test
- **WHEN** `pnpm test:security` submits a transaction with a known test PAN and CVV and then captures all service logs, all topic messages and a dump of every non-vault schema
- **THEN** neither value is found in any of them

### Requirement: Log redaction
Structured logs SHALL redact `*.pan`, `*.cvv`, `*.card`, `authorization`, `cookie` and `password` paths (SPEC §7).

#### Scenario: Request body logged
- **WHEN** a request containing a card object is logged at debug level
- **THEN** the card fields appear as `[Redacted]`

### Requirement: Hashed device identifiers
IP addresses and device IDs SHALL be hashed with SHA-256 and a pepper before leaving `transaction-api` (SPEC §4.9).

#### Scenario: Raw IP not published
- **WHEN** a transaction with IP `203.0.113.10` is published
- **THEN** the event contains `device.ipHash` prefixed `sha256:` and not the raw IP
