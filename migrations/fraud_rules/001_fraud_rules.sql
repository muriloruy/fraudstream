-- Up Migration
-- fraud-rules state (SPEC §5.3).

-- Materialized from the compacted accounts.profiles.v1 topic.
CREATE TABLE account_profiles (
  account_id   text          PRIMARY KEY,
  home_country char(2)       NOT NULL,
  home_city    text,
  risk_tier    text          NOT NULL CHECK (risk_tier IN ('LOW','MEDIUM','HIGH')),
  credit_limit numeric(18,2) NOT NULL CHECK (credit_limit >= 0),
  updated_at   timestamptz   NOT NULL
);

-- Sliding-window source: one row per evaluated transaction.
CREATE TABLE account_activity (
  account_id     text          NOT NULL,
  transaction_id uuid          NOT NULL,
  amount         numeric(18,2) NOT NULL,
  merchant_id    text          NOT NULL,
  country        char(2)       NOT NULL,
  geo_lat        numeric(8,5),
  geo_lon        numeric(8,5),
  occurred_at    timestamptz   NOT NULL,
  -- Query: every window aggregate of the rule context, e.g.
  --   SELECT count(*) FROM account_activity WHERE account_id = $1 AND occurred_at > $2 - interval '60 seconds'
  -- and "last transaction of the account" (ORDER BY occurred_at DESC LIMIT 1): an index range scan.
  PRIMARY KEY (account_id, occurred_at, transaction_id)
);
-- Query: cleanup job "DELETE ... WHERE occurred_at < now() - interval '30 days'".
CREATE INDEX account_activity_occurred_at_idx ON account_activity (occurred_at);

-- Merchants already seen per account (R007 new_merchant_high_amount). The PK serves the lookup.
CREATE TABLE known_merchants (
  account_id  text        NOT NULL,
  merchant_id text        NOT NULL,
  first_seen  timestamptz NOT NULL,
  PRIMARY KEY (account_id, merchant_id)
);

-- R008 blocklisted. The PK serves the lookup "WHERE (kind, value) IN (...)".
CREATE TABLE blocklist (
  kind       text        NOT NULL CHECK (kind IN ('MERCHANT','MCC','BIN')),
  value      text        NOT NULL,
  reason     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);

-- Demo blocklist: an online-gambling MCC, a known-bad merchant and a test BIN.
INSERT INTO blocklist (kind, value, reason) VALUES
  ('MCC', '7995', 'betting / online gambling'),
  ('MERCHANT', 'mer_blocked', 'confirmed merchant compromise'),
  ('BIN', '999999', 'issuer reported counterfeit BIN');

-- Transactional outbox (SPEC §4.4, §4.5): FraudRulesEvaluated events, published by the
-- relay embedded in the service.
CREATE TABLE outbox (
  id            bigserial    PRIMARY KEY,
  event_id      uuid         NOT NULL UNIQUE,
  topic         text         NOT NULL,
  message_key   text         NOT NULL,
  payload       jsonb        NOT NULL,
  headers       jsonb        NOT NULL DEFAULT '{}',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      int          NOT NULL DEFAULT 0,
  last_error    text
);
-- Query: relay batch "WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED".
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Down Migration
DROP TABLE outbox;
DROP TABLE blocklist;
DROP TABLE known_merchants;
DROP TABLE account_activity;
DROP TABLE account_profiles;
