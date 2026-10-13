-- Up Migration
-- alerts-gateway state (SPEC §5.7, §6.8).

CREATE TABLE alerts (
  alert_id       uuid         PRIMARY KEY,
  transaction_id uuid         NOT NULL UNIQUE,    -- one alert per transaction, ever
  account_id     text         NOT NULL,
  decision       text         NOT NULL CHECK (decision IN ('REVIEW','DECLINE')),
  final_score    numeric(5,4) NOT NULL,
  reasons        text[]       NOT NULL,
  snapshot       jsonb        NOT NULL,           -- transaction + rule + score details for the UI (masked PAN only)
  status         text         NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','CONFIRMED_FRAUD','LEGITIMATE')),
  assigned_to    uuid,
  created_at     timestamptz  NOT NULL,
  resolved_at    timestamptz
);
-- Query: alert queue "WHERE status IN ('OPEN','IN_PROGRESS') AND <keyset after cursor>
--   ORDER BY final_score DESC, created_at, alert_id LIMIT n" (SPEC §5.7, extended with alert_id
--   so the keyset is total).
CREATE INDEX alerts_queue_idx ON alerts (final_score DESC, created_at, alert_id)
  WHERE status IN ('OPEN','IN_PROGRESS');
-- Query: queue filtered by account "WHERE account_id = $1 ... ORDER BY final_score DESC ..." and
--   alerts of an account by time.
CREATE INDEX alerts_account_idx ON alerts (account_id, created_at DESC);

-- Append-only: alerts_svc may insert and read, never change or remove (see REVOKE below).
CREATE TABLE audit_log (
  id          bigserial   PRIMARY KEY,
  actor_id    uuid        NOT NULL,              -- 00000000-0000-0000-0000-000000000000 = anonymous
  action      text        NOT NULL,              -- 'ALERT_VIEWED','ALERT_RESOLVED','DLQ_REPLAYED','LOGIN'...
  target_type text        NOT NULL,
  target_id   text        NOT NULL,
  metadata    jsonb       NOT NULL DEFAULT '{}',
  ip_hash     char(64),
  created_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM alerts_svc;

-- Projection of payments.transactions.v1 for alert snapshots: the decision event carries no
-- transaction details (SPEC §4.9). Card data is the masked PAN only.
CREATE TABLE transactions_seen (
  transaction_id uuid        PRIMARY KEY,
  account_id     text        NOT NULL,
  details        jsonb       NOT NULL,           -- amount, merchant, masked PAN, channel, entry mode, geo
  requested_at   timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
-- Query: purge job "DELETE ... WHERE recorded_at < now() - retention".
CREATE INDEX transactions_seen_recorded_at_idx ON transactions_seen (recorded_at);

-- Account timeline (decisions and ledger postings), trimmed to the last 100 per account.
CREATE TABLE account_events (
  id             bigserial   PRIMARY KEY,
  account_id     text        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('DECISION','LEDGER')),
  transaction_id uuid        NOT NULL,
  occurred_at    timestamptz NOT NULL,
  payload        jsonb       NOT NULL,
  UNIQUE (kind, transaction_id)                  -- idempotent projection
);
-- Query: timeline and trim "WHERE account_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 100".
CREATE INDEX account_events_timeline_idx ON account_events (account_id, occurred_at DESC, id DESC);

-- Per-second decision counters for /v1/metrics/summary and metrics.tick. Latency is kept as a
-- fixed-bucket histogram (upper bounds in ms, see LATENCY_BUCKETS_MS in the service), so p95 is
-- an estimate, as with Prometheus histograms.
CREATE TABLE decision_stats (
  bucket          timestamptz PRIMARY KEY,       -- date_trunc('second', decided_at)
  approve         int         NOT NULL DEFAULT 0,
  review          int         NOT NULL DEFAULT 0,
  decline         int         NOT NULL DEFAULT 0,
  latency_buckets int[]       NOT NULL
);
-- The primary key serves "WHERE bucket >= now() - $window" and the daily purge.

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
DROP TABLE decision_stats;
DROP TABLE account_events;
DROP TABLE transactions_seen;
DROP TABLE audit_log;
DROP TABLE alerts;
