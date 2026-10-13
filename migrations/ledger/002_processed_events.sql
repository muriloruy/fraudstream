-- Up Migration
-- Inbox for idempotent consumers (SPEC §4.4). Added to a service's migrations with
-- `pnpm migrations:add-inbox <service>`; the consumer runtime (libs/kafka) inserts a row in
-- the same DB transaction as the side effects and skips events it has already seen.
CREATE TABLE processed_events (
  consumer_group text        NOT NULL,
  event_id       uuid        NOT NULL,
  processed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_group, event_id)
);
-- Query: hourly purge "DELETE ... WHERE processed_at < now() - retention" (topic retention + 1 day).
CREATE INDEX processed_events_processed_at_idx ON processed_events (processed_at);

-- Down Migration
DROP TABLE processed_events;
