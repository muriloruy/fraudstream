-- Up Migration
-- Double-entry ledger (SPEC §5.6, §6.7).

CREATE TABLE journals (
  journal_id     uuid        PRIMARY KEY,
  transaction_id uuid        NOT NULL UNIQUE,     -- idempotency at business level: one journal per transaction
  posted_at      timestamptz NOT NULL
);

CREATE TABLE entries (
  entry_id       bigserial     PRIMARY KEY,
  journal_id     uuid          NOT NULL REFERENCES journals,
  ledger_account text          NOT NULL,
  direction      char(1)       NOT NULL CHECK (direction IN ('D','C')),
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  currency       char(3)       NOT NULL
);
-- Query: account statement / timeline "WHERE ledger_account = $1 ORDER BY entry_id DESC".
CREATE INDEX entries_account_idx ON entries (ledger_account, entry_id DESC);
-- Query: balanced-journal trigger and reconciliation "WHERE journal_id = $1" / "GROUP BY journal_id".
CREATE INDEX entries_journal_idx ON entries (journal_id);

CREATE TABLE balances (
  ledger_account text          PRIMARY KEY,
  currency       char(3)       NOT NULL,
  balance        numeric(18,2) NOT NULL,
  version        bigint        NOT NULL           -- optimistic locking
);

-- Invariant: for every journal and currency, sum(D) = sum(C). Checked at COMMIT (deferred), so the
-- entries of one journal can be inserted one by one; an unbalanced journal aborts the transaction.
CREATE FUNCTION assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unbalanced text;
BEGIN
  SELECT currency INTO unbalanced
    FROM entries
   WHERE journal_id = NEW.journal_id
   GROUP BY currency
  HAVING sum(CASE direction WHEN 'D' THEN amount ELSE -amount END) <> 0
   LIMIT 1;
  IF unbalanced IS NOT NULL THEN
    RAISE EXCEPTION 'journal % is unbalanced in %', NEW.journal_id, unbalanced
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- Append-only: corrections are new journals. Revoked from the service role itself; in production
-- the migrations would run as a separate owner role so the service could not grant them back.
REVOKE UPDATE, DELETE, TRUNCATE ON entries FROM ledger_svc;
REVOKE DELETE, TRUNCATE ON journals FROM ledger_svc;
-- journals keeps UPDATE because the entries foreign key check locks the parent row (FOR KEY
-- SHARE), which PostgreSQL only allows with UPDATE privilege; a trigger forbids the update itself.
CREATE FUNCTION reject_journal_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journals are immutable; post a reversal journal instead'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER journals_immutable
  BEFORE UPDATE ON journals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_update();

-- Local projection of payments.transactions.v1: FraudDecisionMade carries no amount or merchant
-- (SPEC §4.9), so the ledger joins the decision with what it saw of the transaction.
CREATE TABLE pending_transactions (
  transaction_id uuid          PRIMARY KEY,
  account_id     text          NOT NULL,
  merchant_id    text          NOT NULL,
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  currency       char(3)       NOT NULL,
  requested_at   timestamptz   NOT NULL,
  recorded_at    timestamptz   NOT NULL DEFAULT now()
);
-- Query: purge job "DELETE ... WHERE recorded_at < now() - retention".
CREATE INDEX pending_transactions_recorded_at_idx ON pending_transactions (recorded_at);

-- Transactional outbox: LedgerEntriesPosted events, published by the relay embedded in the service.
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
DROP TABLE pending_transactions;
DROP TABLE balances;
DROP TABLE entries;
DROP TABLE journals;
DROP FUNCTION assert_journal_balanced();
DROP FUNCTION reject_journal_update();
