-- Up Migration
-- anomaly-scorer state (SPEC §5.4).

-- Per-account exponentially weighted statistics. The PK serves the per-transaction
-- "SELECT ... WHERE account_id = $1 FOR UPDATE".
CREATE TABLE account_baselines (
  account_id           text             PRIMARY KEY,
  n                    int              NOT NULL CHECK (n >= 0),
  amount_ewma          double precision NOT NULL,   -- on ln(amount)
  amount_ewm_var       double precision NOT NULL,
  interarrival_ewma    double precision NOT NULL,   -- on ln(seconds)
  interarrival_ewm_var double precision NOT NULL,
  hour_histogram       int[]            NOT NULL CHECK (cardinality(hour_histogram) = 24),
  last_tx_at           timestamptz      NOT NULL,
  model_version        text             NOT NULL,
  updated_at           timestamptz      NOT NULL
);

-- Risk tier per account (cold-start defaults), from accounts.profiles.v1.
CREATE TABLE account_profiles (
  account_id text        PRIMARY KEY,
  risk_tier  text        NOT NULL CHECK (risk_tier IN ('LOW','MEDIUM','HIGH')),
  updated_at timestamptz NOT NULL
);

-- Merchants seen per account (newMerchant feature). The PK serves the lookup.
CREATE TABLE known_merchants (
  account_id  text        NOT NULL,
  merchant_id text        NOT NULL,
  first_seen  timestamptz NOT NULL,
  PRIMARY KEY (account_id, merchant_id)
);

-- Last 50 contributions per account with the baseline before each, so a transaction later
-- confirmed as fraud can be removed exactly by replaying the ones after it (SPEC §6.5).
CREATE TABLE contributions (
  seq            bigserial   PRIMARY KEY,
  account_id     text        NOT NULL,
  transaction_id uuid        NOT NULL UNIQUE,  -- Query: find the contribution named by analyst feedback
  prior          jsonb,                        -- baseline before this transaction (null = first)
  tier           text        NOT NULL,
  observation    jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Query: "contributions of an account in order" (revert, trim to the last 50).
CREATE INDEX contributions_account_seq_idx ON contributions (account_id, seq);

-- Transactional outbox: AnomalyScored events, published by the relay embedded in the service.
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
DROP TABLE contributions;
DROP TABLE known_merchants;
DROP TABLE account_profiles;
DROP TABLE account_baselines;
