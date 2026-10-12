# Tasks

## 1. Schema and invariants (SPEC §5.6)

- [x] 1.1 Migrations `migrations/ledger/` (journals, entries, balances, pending_transactions projection, processed_events, outbox) with index comments; verify with `pnpm db:migrate`
- [x] 1.2 Deferred constraint trigger enforcing `sum(D) = sum(C)` per journal; integration test: unbalanced journal rejected at commit, balanced accepted
- [x] 1.3 Revoke `UPDATE/DELETE/TRUNCATE` on `ledger.entries` from `ledger_svc`; integration test asserts permission error

## 2. Posting service (SPEC §6.7)

- [x] 2.1 Scaffold `apps/ledger`; pure domain `buildJournal(decision, tx)` with decimal arithmetic; unit tests for entry construction and direction mapping
- [x] 2.2 Projection consumer of `payments.transactions.v1` (amount, currency, merchant); integration test for idempotent upsert
- [x] 2.3 Decision consumer: ignore non-APPROVE, create journal + entries + balances (optimistic locking with retry) + outbox `LedgerEntriesPosted` in one transaction; missing projection → transient error; integration tests for approve, decline, and redelivery after clearing `processed_events` (still one journal)
- [x] 2.4 Concurrency test: 500 concurrent approvals to one merchant → balance equals sum of credits, no lost updates
- [x] 2.5 Add service and relay to compose; verify `ledger.entries.v1` receives events

## 3. Reconciliation

- [x] 3.1 Write `docs/sql/reconciliation.sql` (unbalanced journals, approved decisions without journal, net balance per currency) run by a dedicated read-only `reconciler` role with `SELECT` on `decision` and `ledger`, plus `pnpm ledger:reconcile`; integration test asserts a clean report after a seeded run and a dirty report when a journal is removed by a superuser

## 4. Verification

- [ ] 4.1 Run `pnpm lint && pnpm typecheck && pnpm test`; CI green
- [ ] 4.2 Tick every M4 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m4-ledger` after merge.
