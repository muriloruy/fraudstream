# Spec Delta

## Purpose

Keeps the transaction record owned by the public API in sync with the fraud decision, so clients polling the API see the final outcome.

## ADDED Requirements

### Requirement: Status reflects decision
When a `FraudDecisionMade` is consumed, the transaction SHALL be updated to `APPROVED`, `REVIEW` or `DECLINED` with `final_score` and `decided_at`, idempotently.

#### Scenario: Decline reflected
- **WHEN** a `DECLINE` decision for a pending transaction is consumed
- **THEN** `GET /v1/transactions/:id` returns status `DECLINED` with the final score

#### Scenario: End-to-end card testing
- **WHEN** a burst of small transactions for one account is submitted through the API
- **THEN** a transaction in the burst reaches status `DECLINED` within 3 s of its POST
