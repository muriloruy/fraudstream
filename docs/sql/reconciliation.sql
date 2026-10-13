-- Ledger reconciliation (SPEC §5.6, M4). Run nightly as the read-only `reconciler` role:
--   pnpm ledger:reconcile                      (JSON report, exit code 1 when dirty)
--   psql "$DATABASE_URL_RECONCILER" -f docs/sql/reconciliation.sql
-- Decisions younger than `reconcile.grace_seconds` (default 300) are not expected to have a
-- journal yet: the ledger posts asynchronously. Override with
--   SET reconcile.grace_seconds = '0';
-- Every query returns rows only for problems, except net_balance_per_currency, whose `net`
-- must be 0.00 for every currency. Each query is preceded by a `-- name:` line.

-- name: unbalanced_journals
-- Journals whose debits and credits differ in a currency, or that have no entries at all.
SELECT j.journal_id,
       j.transaction_id,
       e.currency,
       coalesce(sum(e.amount) FILTER (WHERE e.direction = 'D'), 0) AS debits,
       coalesce(sum(e.amount) FILTER (WHERE e.direction = 'C'), 0) AS credits
  FROM ledger.journals j
  LEFT JOIN ledger.entries e USING (journal_id)
 GROUP BY j.journal_id, j.transaction_id, e.currency
HAVING count(e.entry_id) = 0
    OR coalesce(sum(e.amount) FILTER (WHERE e.direction = 'D'), 0)
    <> coalesce(sum(e.amount) FILTER (WHERE e.direction = 'C'), 0)
 ORDER BY j.journal_id;

-- name: approved_without_journal
-- APPROVE decisions the ledger never posted.
SELECT d.transaction_id, d.account_id, d.decided_at
  FROM decision.decisions d
 WHERE d.decision = 'APPROVE'
   AND d.decided_at < now() - make_interval(
         secs => coalesce(nullif(current_setting('reconcile.grace_seconds', true), ''), '300')::int)
   AND NOT EXISTS (SELECT 1 FROM ledger.journals j WHERE j.transaction_id = d.transaction_id)
 ORDER BY d.decided_at;

-- name: net_balance_per_currency
-- Money only moves between accounts: the sum of all balances is zero in every currency.
SELECT currency, sum(balance) AS net, count(*) AS accounts
  FROM ledger.balances
 GROUP BY currency
 ORDER BY currency;

-- name: balance_drift
-- Balances that disagree with their entries (credits minus debits).
SELECT b.ledger_account, b.balance, coalesce(e.net, 0) AS from_entries
  FROM ledger.balances b
  LEFT JOIN (
        SELECT ledger_account,
               sum(CASE direction WHEN 'C' THEN amount ELSE -amount END) AS net
          FROM ledger.entries
         GROUP BY ledger_account
       ) e USING (ledger_account)
 WHERE b.balance <> coalesce(e.net, 0)
 ORDER BY b.ledger_account;
