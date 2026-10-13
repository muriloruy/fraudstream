# alert-management Specification

## Purpose
Turns REVIEW and DECLINE decisions into a prioritized, auditable alert queue that analysts work through, and feeds their verdicts back into the detection models.

## Requirements

### Requirement: Alerts from decisions
Each `REVIEW` or `DECLINE` decision SHALL create exactly one alert with status `OPEN`, the score, reasons and a snapshot of transaction, rule and score details (masked PAN only).

#### Scenario: Review decision
- **WHEN** a `REVIEW` decision is consumed twice
- **THEN** one `OPEN` alert exists for that transaction

#### Scenario: Approve decision
- **WHEN** an `APPROVE` decision is consumed
- **THEN** no alert is created

### Requirement: Alert queue
`GET /v1/alerts` SHALL filter by status, minimum score and account, and paginate with an opaque keyset cursor on `(final_score, created_at, alert_id)` ordered by highest score first.

#### Scenario: Stable pagination
- **WHEN** a client pages through 250 alerts with `limit=100` while new alerts arrive
- **THEN** no alert is returned twice or skipped among those existing at the first request

#### Scenario: Invalid cursor
- **WHEN** a tampered cursor is sent
- **THEN** the response is 400

### Requirement: Alert detail is audited
`GET /v1/alerts/:id` SHALL return the alert with its snapshot and write an `ALERT_VIEWED` audit entry.

#### Scenario: View recorded
- **WHEN** an analyst opens an alert
- **THEN** an audit row with actor, action `ALERT_VIEWED` and the alert id exists

### Requirement: Assign and resolve
Analysts SHALL be able to assign an alert to themselves (status `IN_PROGRESS`) and resolve it with verdict `CONFIRMED_FRAUD` or `LEGITIMATE` and a required note; resolution SHALL update the alert, write an audit entry and publish `AnalystFeedbackRecorded` atomically.

#### Scenario: Resolve as legitimate
- **WHEN** an analyst resolves an alert as `LEGITIMATE` with a note
- **THEN** the alert status is `LEGITIMATE`, `resolved_at` is set, an audit row exists and a feedback event is published

#### Scenario: Missing note
- **WHEN** a resolution has an empty note
- **THEN** the response is 400 and nothing changes

#### Scenario: Already resolved
- **WHEN** a resolved alert is resolved again
- **THEN** the response is 409

### Requirement: Append-only audit log
The audit log SHALL be append-only for the service role.

#### Scenario: Delete denied
- **WHEN** the `alerts_svc` role attempts to delete an audit row
- **THEN** PostgreSQL returns a permission error

### Requirement: Account timeline
`GET /v1/accounts/:accountId/timeline` SHALL return the last 100 decisions and ledger postings for the account, newest first.

#### Scenario: Mixed timeline
- **WHEN** an account has decisions and ledger postings
- **THEN** the timeline lists both types ordered by time, at most 100 items

### Requirement: Metrics summary
`GET /v1/metrics/summary?window=15m` SHALL return transactions per second, approve/review/decline rates and p95 decision latency for the window.

#### Scenario: Summary values
- **WHEN** the summary is requested after a known set of decisions
- **THEN** the rates match the counts of those decisions
