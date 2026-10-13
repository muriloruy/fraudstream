# Design

## Context

Consumes decisions produced in M3 using the M2 runtime. See proposal.md and the `ledger-posting` spec.

## Goals / Non-Goals

**Goals:** invariants enforced in SQL, not only in code; idempotency at two levels (inbox + business key).

**Non-Goals:** multi-currency conversion, reversals (stretch), interest/fees.

## Decisions

- **Amount source**: `FraudDecisionMade` does not carry amount/merchant (SPEC §4.9). The ledger keeps a local projection `ledger.pending_transactions` fed by `payments.transactions.v1` (amount, currency, merchant) and joins on decision. Alternative — add optional fields to the decision event (backward compatible per SPEC §4.10) — rejected to keep the decision payload as specified. Recorded in the README.
- **Balanced-journal trigger**: `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on `ledger.entries` checking sums per `journal_id` at commit.
- **Business idempotency**: `journals.transaction_id UNIQUE`; on conflict the handler treats it as duplicate (no error).
- **Balances**: `INSERT ... ON CONFLICT DO NOTHING` to create, then `UPDATE ... SET balance = balance ± $amt, version = version + 1 WHERE ledger_account = $1 AND version = $v`; retry up to 5 times on 0 rows. Customer debit decreases, merchant credit increases; net across all accounts is zero.
- **Privileges**: migration `REVOKE UPDATE, DELETE, TRUNCATE ON ledger.entries FROM ledger_svc`.
- **Direction mapping**: DB `char(1)` `D/C` ↔ contract `DEBIT/CREDIT` in the infrastructure mapper.

## Risks / Trade-offs

- [Decision arrives before the transaction projection] → both topics are co-partitioned by `accountId`, but ordering across topics is not guaranteed; if missing, treat as transient error (retry topic) until the projection arrives.
- [Hot merchant balance row under merchant_compromise] → optimistic retry; measured in M8.
