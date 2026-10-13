-- Up Migration
-- Account view of the dashboard (SPEC §8.2 Account Timeline): profile and balance projections,
-- so the gateway never reads another service's schema (least privilege).

-- Projection of the compacted accounts.profiles.v1 (tombstones delete the row).
CREATE TABLE account_profiles (
  account_id   text          PRIMARY KEY,
  home_country char(2)       NOT NULL,
  home_city    text,
  risk_tier    text          NOT NULL CHECK (risk_tier IN ('LOW','MEDIUM','HIGH')),
  credit_limit numeric(18,2) NOT NULL,
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

-- Customer balance from LedgerEntriesPosted (debits decrease it, credits increase it), applied
-- once per posting: only when the LEDGER account event is new (account_events is the guard).
CREATE TABLE account_balances (
  account_id text          PRIMARY KEY,
  currency   char(3)       NOT NULL,
  balance    numeric(18,2) NOT NULL,
  updated_at timestamptz   NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE account_balances;
DROP TABLE account_profiles;
