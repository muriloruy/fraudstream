# Proposal

## Why

Approved transactions must move money in a way that is provably correct even under redelivery and crashes. Milestone M4 (SPEC §17) adds a double-entry ledger whose invariants (balanced journals, one journal per transaction, append-only entries) are enforced by the database and verified by reconciliation — the basis for the chaos test in M8.

## What Changes

- New service `ledger` consuming `fraud.decisions.v1` (`APPROVE` only), posting one journal with a customer debit and a merchant credit, updating balances with optimistic locking, and publishing `LedgerEntriesPosted` via outbox (SPEC §5.6, §6.7).
- `ledger` migrations with a deferred constraint trigger enforcing `sum(D) = sum(C)` per journal and `UPDATE`/`DELETE` revoked on entries.
- `docs/sql/reconciliation.sql` + automated reconciliation test.

Out of scope: reversal journals for later-confirmed fraud (stretch in SPEC §6.7).

## Capabilities

### New Capabilities
- `ledger-posting`: double-entry posting of approved transactions with balance tracking, immutability and reconciliation.

### Modified Capabilities
<!-- none -->

## Impact

- New app `ledger`, migrations `migrations/ledger/`, outbox relay instance for `ledger`, `docs/sql/reconciliation.sql`.
