-- Up Migration
-- Idempotency-Key replay store (SPEC §5.1): same key + same body -> stored response,
-- same key + different body -> 422, key still being processed (response_status 0) -> 409.
CREATE TABLE idempotency_keys (
  idempotency_key text        PRIMARY KEY,
  request_hash    char(64)    NOT NULL,   -- HMAC-SHA256(pepper, canonical request body); never the body
  response_status int         NOT NULL,   -- 0 while the request is in progress
  response_body   jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox (SPEC §4.5): written in the same DB transaction as the business row,
-- published to Kafka by outbox-relay.
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
-- Query: relay batch "WHERE published_at IS NULL ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED",
-- plus the outbox_lag_rows / oldest-unpublished metrics. Partial, so it stays tiny.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Client API keys (SPEC §6.1). Only a SHA-256 of the key is stored; keys are 32 random
-- bytes, so a fast hash is enough (no brute-force risk as with passwords).
CREATE TABLE api_keys (
  key_id      uuid        PRIMARY KEY,
  name        text        NOT NULL,
  key_hash    char(64)    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
-- Query: authenticate a request by the hash of its X-Api-Key header.
CREATE UNIQUE INDEX api_keys_hash_key ON api_keys (key_hash);

-- Down Migration
DROP TABLE api_keys;
DROP TABLE outbox;
DROP TABLE idempotency_keys;
