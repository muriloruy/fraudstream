-- Up Migration
-- decision-engine state (SPEC §5.5).

-- Join of rule result and anomaly score per transaction until both arrive or the deadline passes.
-- Each part is stored as {"envelope": ..., "traceparent": ...} to decide and publish later.
CREATE TABLE pending (
  transaction_id uuid        PRIMARY KEY,
  account_id     text        NOT NULL,
  rule_result    jsonb,
  anomaly_score  jsonb,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  deadline_at    timestamptz NOT NULL            -- first_seen_at + join timeout (2 s)
);
-- Query: timeout sweeper "WHERE deadline_at < now() ORDER BY deadline_at LIMIT n FOR UPDATE SKIP LOCKED".
CREATE INDEX pending_deadline_idx ON pending (deadline_at);

CREATE TABLE decisions (
  transaction_id uuid          PRIMARY KEY,     -- one decision per transaction, ever
  account_id     text          NOT NULL,
  decision       text          NOT NULL CHECK (decision IN ('APPROVE','REVIEW','DECLINE')),
  final_score    numeric(5,4)  NOT NULL,
  rule_score     numeric(5,4),
  anomaly_score  numeric(5,4),
  partial        boolean       NOT NULL,
  reasons        text[]        NOT NULL,
  config_version text          NOT NULL,
  latency_ms     int           NOT NULL,
  decided_at     timestamptz   NOT NULL
);
-- Query: account timeline / evaluation "WHERE account_id = $1 ORDER BY decided_at DESC".
CREATE INDEX decisions_account_time_idx ON decisions (account_id, decided_at DESC);

-- Transactional outbox: FraudDecisionMade events, published by the relay embedded in the service.
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
DROP TABLE decisions;
DROP TABLE pending;
