-- Up Migration
-- The reconciler checks that every APPROVE decision has a ledger journal (docs/sql/reconciliation.sql).
GRANT USAGE ON SCHEMA decision TO reconciler;
GRANT SELECT ON decisions TO reconciler;

-- Down Migration
REVOKE SELECT ON decisions FROM reconciler;
REVOKE USAGE ON SCHEMA decision FROM reconciler;
