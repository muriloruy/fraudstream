-- Up Migration
-- Read-only access for the `reconciler` role (docs/sql/reconciliation.sql, `pnpm ledger:reconcile`).
GRANT USAGE ON SCHEMA ledger TO reconciler;
GRANT SELECT ON journals, entries, balances TO reconciler;

-- Down Migration
REVOKE SELECT ON journals, entries, balances FROM reconciler;
REVOKE USAGE ON SCHEMA ledger FROM reconciler;
