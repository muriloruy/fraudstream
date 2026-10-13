# Spec Delta

## Purpose

Records the financial effect of every approved transaction as balanced, immutable double-entry journals with up-to-date account balances that can be reconciled at any time.

## ADDED Requirements

### Requirement: Post approved transactions
For each `APPROVE` decision the ledger SHALL create one journal with a `DEBIT` on `customer:<accountId>` and a `CREDIT` on `merchant:<merchantId>` for the transaction amount and currency, and publish `LedgerEntriesPosted`; `REVIEW` and `DECLINE` SHALL produce no entries (SPEC §6.7).

#### Scenario: Approved transaction
- **WHEN** an `APPROVE` decision for 1250.90 BRL is consumed
- **THEN** one journal with two entries of 1250.90 BRL exists and a `LedgerEntriesPosted` event is published

#### Scenario: Declined transaction
- **WHEN** a `DECLINE` decision is consumed
- **THEN** no journal is created

### Requirement: One journal per transaction
The ledger SHALL never create more than one journal per `transactionId`, even if the decision is redelivered or replayed.

#### Scenario: Redelivered decision
- **WHEN** the same approval is delivered three times, including after clearing `processed_events`
- **THEN** exactly one journal exists for that transaction

### Requirement: Balanced journals
Every journal SHALL have total debits equal to total credits, enforced by the database at commit time.

#### Scenario: Unbalanced insert rejected
- **WHEN** a journal with a debit of 10.00 and a credit of 9.99 is committed
- **THEN** the database rejects the transaction

### Requirement: Append-only entries
Ledger entries SHALL be immutable: the service role SHALL NOT be able to update or delete them; corrections are new journals.

#### Scenario: Update denied
- **WHEN** the `ledger_svc` role runs `UPDATE ledger.entries`
- **THEN** PostgreSQL returns a permission error

### Requirement: Consistent balances
Balances SHALL be updated in the same transaction as the journal using optimistic locking, retrying on version conflict.

#### Scenario: Concurrent postings
- **WHEN** many approvals for the same merchant are posted concurrently
- **THEN** the merchant balance equals the sum of its credits

### Requirement: Reconciliation
A reconciliation query SHALL report any journal whose debits and credits differ, any approved decision without a journal, and the net of all balances per currency (which SHALL be zero).

#### Scenario: Clean ledger
- **WHEN** reconciliation runs after a batch of postings
- **THEN** it reports zero unbalanced journals and a net balance of zero per currency
