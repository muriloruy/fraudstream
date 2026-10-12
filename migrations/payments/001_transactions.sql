-- Up Migration
-- Authorization requests owned by transaction-api (SPEC §5.1), range-partitioned by month.
CREATE TABLE transactions (
  transaction_id   uuid          NOT NULL,
  account_id       text          NOT NULL,
  card_token       text          NOT NULL,
  masked_pan       char(16)      NOT NULL CHECK (masked_pan ~ '^[0-9]{6}[*]{6}[0-9]{4}$'),
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  currency         char(3)       NOT NULL,
  merchant_id      text          NOT NULL,
  merchant_mcc     char(4)       NOT NULL,
  merchant_country char(2)       NOT NULL,
  channel          text          NOT NULL CHECK (channel IN ('ECOMMERCE','POS','ATM')),
  status           text          NOT NULL CHECK (status IN ('PENDING','APPROVED','REVIEW','DECLINED')),
  final_score      numeric(5,4),
  requested_at     timestamptz   NOT NULL,
  decided_at       timestamptz,
  PRIMARY KEY (transaction_id, requested_at)
) PARTITION BY RANGE (requested_at);

-- Query: account history screen, newest first
--   SELECT ... WHERE account_id = $1 ORDER BY requested_at DESC LIMIT n
CREATE INDEX tx_account_time_idx ON transactions (account_id, requested_at DESC);
-- Query: "pending older than N seconds" health check (partial: only PENDING rows are indexed)
--   SELECT count(*) WHERE status = 'PENDING' AND requested_at < now() - $1::interval
CREATE INDEX tx_pending_idx ON transactions (requested_at) WHERE status = 'PENDING';
-- Query: GET /v1/transactions/:id and the decision status update (M3), which know only the id.
-- The primary key starts with transaction_id too, but this narrower index is cheaper per partition.
CREATE INDEX tx_id_idx ON transactions (transaction_id);

-- Creates the monthly partitions transactions_YYYY_MM for `months` months starting at
-- `from_month`. Idempotent; called by migrations and periodically by transaction-api.
CREATE FUNCTION ensure_monthly_partitions(from_month date, months int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  start_date date := date_trunc('month', from_month)::date;
  partition_start date;
BEGIN
  FOR i IN 0 .. months - 1 LOOP
    partition_start := (start_date + make_interval(months => i))::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF transactions FOR VALUES FROM (%L) TO (%L)',
      'transactions_' || to_char(partition_start, 'YYYY_MM'),
      partition_start,
      (partition_start + interval '1 month')::date
    );
  END LOOP;
END;
$$;

SELECT ensure_monthly_partitions(current_date, 3);

-- Down Migration
DROP FUNCTION ensure_monthly_partitions(date, int);
DROP TABLE transactions;
