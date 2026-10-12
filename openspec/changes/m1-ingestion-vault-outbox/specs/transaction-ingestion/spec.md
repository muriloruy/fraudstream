# Spec Delta

## Purpose

The public entry point that accepts payment authorization requests, validates them strictly, guarantees idempotency, and exposes the transaction status.

## ADDED Requirements

### Requirement: Accept authorization requests
`POST /v1/transactions` SHALL validate the request (SPEC §6.1), tokenize the card via the vault, persist the transaction with status `PENDING`, and return `202` with `transactionId`, `status` and `links.self`.

#### Scenario: Valid request accepted
- **WHEN** a valid request with a valid API key and `Idempotency-Key` is sent
- **THEN** the API returns 202 with status `PENDING` and the transaction is stored with `card_token` and `masked_pan` only

### Requirement: Strict input validation
The API SHALL reject unknown fields, PANs that are not 13–19 digits or fail Luhn, CVV not 3–4 digits, amounts that are not positive decimal strings with ≤ 2 decimals and ≤ 1,000,000, currencies outside the ISO 4217 allow-list, invalid ISO 3166-1 countries, non-4-digit MCCs, and bodies over 16 KB.

#### Scenario: Luhn failure
- **WHEN** the PAN fails the Luhn check
- **THEN** the API returns 400 naming the field `card.pan` without echoing its value

#### Scenario: Unknown field
- **WHEN** the body contains a field not in the schema
- **THEN** the API returns 400

#### Scenario: Oversized body
- **WHEN** the body is larger than 16 KB
- **THEN** the API returns 413 or 400 without processing it

### Requirement: Idempotency keys
Each POST SHALL require an `Idempotency-Key` UUID; the same key with the same body SHALL return the stored response, the same key with a different body SHALL return 422, and a key still in progress SHALL return 409 (SPEC §5.1, §6.1).

#### Scenario: Replay returns stored response
- **WHEN** the same request is sent twice with the same key
- **THEN** both responses are identical and only one transaction exists

#### Scenario: Key reused with different body
- **WHEN** a key is reused with a different amount
- **THEN** the API returns 422

### Requirement: API key authentication
Requests SHALL carry `X-Api-Key`, which is verified against a hashed value in the database; missing or invalid keys SHALL return 401.

#### Scenario: Invalid key
- **WHEN** a request uses an unknown API key
- **THEN** the API returns 401 and creates no transaction

### Requirement: Problem Details errors
All error responses SHALL use RFC 9457 `application/problem+json` and SHALL never include stack traces or card data.

#### Scenario: Error shape
- **WHEN** any request fails validation
- **THEN** the response content type is `application/problem+json` with `type`, `title`, `status` and field-level `errors`

### Requirement: Rate limiting
POST requests SHALL be limited per API key (default 100 per minute) and excess requests SHALL return 429.

#### Scenario: Limit exceeded
- **WHEN** an API key sends 101 POSTs within one minute
- **THEN** the 101st returns 429

### Requirement: Dependency failures
If the vault or database is unavailable the API SHALL return 503 and SHALL NOT persist a partial transaction.

#### Scenario: Vault down
- **WHEN** the vault does not respond
- **THEN** the API returns 503 and no transaction or outbox row exists

### Requirement: Status lookup and health
`GET /v1/transactions/:id` SHALL return the current status and decision fields, and `/health/live` and `/health/ready` SHALL report liveness and DB + Kafka readiness.

#### Scenario: Pending status
- **WHEN** a client fetches a just-created transaction
- **THEN** the API returns 200 with status `PENDING`

#### Scenario: Readiness fails without DB
- **WHEN** the database is down
- **THEN** `/health/ready` returns 503
