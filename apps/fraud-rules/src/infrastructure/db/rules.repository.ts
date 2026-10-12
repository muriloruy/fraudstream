import type { AccountProfileUpsertedV1 } from '@fraudstream/contracts';
import { toCents } from '@fraudstream/contracts';
import type { Pool, PoolClient } from '@fraudstream/db';
import type { RuleContext, TransactionFacts } from '../../domain/rules.js';
import type { Ruleset } from '../../domain/ruleset.js';

interface ContextRow {
  count_velocity: number;
  sum_amount_window: string;
  small_testing: number;
  history_count: number;
  history_sum: string;
  last_country: string | null;
  last_lat: string | null;
  last_lon: string | null;
  last_at: Date | null;
  known_merchant: boolean;
  blocklist_hits: string[] | null;
  home_country: string | null;
  credit_limit: string | null;
}

/**
 * The whole rule context in ONE round trip (SPEC §6.4): every window aggregate comes from a
 * single range scan of the account_activity primary key (account_id, occurred_at), plus the
 * last transaction, the known-merchant flag, blocklist hits and the profile.
 * Rows strictly before the transaction's own time are considered, so a redelivered
 * transaction never counts itself.
 */
const CONTEXT_SQL = `
WITH history AS (
  SELECT amount, occurred_at
    FROM account_activity
   WHERE account_id = $1
     AND occurred_at >= $2::timestamptz - make_interval(days => $3)
     AND occurred_at < $2::timestamptz
), windows AS (
  SELECT
    count(*) FILTER (WHERE occurred_at >= $2::timestamptz - make_interval(secs => $4))::int AS count_velocity,
    coalesce(sum(amount) FILTER (WHERE occurred_at >= $2::timestamptz - make_interval(secs => $5)), 0)::text AS sum_amount_window,
    count(*) FILTER (WHERE occurred_at >= $2::timestamptz - make_interval(secs => $6) AND amount < $7::numeric)::int AS small_testing,
    count(*)::int AS history_count,
    coalesce(sum(amount), 0)::text AS history_sum
  FROM history
), last_tx AS (
  SELECT country, geo_lat, geo_lon, occurred_at
    FROM account_activity
   WHERE account_id = $1 AND occurred_at < $2::timestamptz
   ORDER BY occurred_at DESC
   LIMIT 1
)
SELECT w.*,
       l.country AS last_country, l.geo_lat::text AS last_lat, l.geo_lon::text AS last_lon, l.occurred_at AS last_at,
       EXISTS (SELECT 1 FROM known_merchants WHERE account_id = $1 AND merchant_id = $8) AS known_merchant,
       (SELECT array_agg(kind || ':' || value ORDER BY kind)
          FROM blocklist
         WHERE (kind = 'MERCHANT' AND value = $8) OR (kind = 'MCC' AND value = $9) OR (kind = 'BIN' AND value = $10)
       ) AS blocklist_hits,
       p.home_country, p.credit_limit::text AS credit_limit
  FROM windows w
  LEFT JOIN last_tx l ON true
  LEFT JOIN account_profiles p ON p.account_id = $1`;

export class RulesRepository {
  constructor(private readonly ruleset: Ruleset) {}

  async loadContext(db: Pick<PoolClient, 'query'>, tx: TransactionFacts): Promise<RuleContext> {
    const r = this.ruleset.rules;
    const { rows } = await db.query<ContextRow>(CONTEXT_SQL, [
      tx.accountId,
      tx.requestedAt.toISOString(),
      r.R003.historyDays,
      r.R001.windowSeconds,
      r.R002.windowSeconds,
      r.R006.windowSeconds,
      r.R006.smallAmount,
      tx.merchantId,
      tx.mcc,
      tx.bin,
    ]);
    const row = rows[0];
    if (!row) throw new Error('context query returned no row');
    return {
      countInVelocityWindow: row.count_velocity,
      sumInAmountWindowCents: toCents(normalizeNumeric(row.sum_amount_window)),
      smallInTestingWindow: row.small_testing,
      historyCount: row.history_count,
      historySumCents: toCents(normalizeNumeric(row.history_sum)),
      last:
        row.last_country && row.last_at
          ? {
              country: row.last_country,
              lat: row.last_lat === null ? null : Number(row.last_lat),
              lon: row.last_lon === null ? null : Number(row.last_lon),
              at: row.last_at,
            }
          : null,
      knownMerchant: row.known_merchant,
      blocklistHits: row.blocklist_hits ?? [],
      profile:
        row.home_country && row.credit_limit
          ? {
              homeCountry: row.home_country,
              creditLimitCents: toCents(normalizeNumeric(row.credit_limit)),
            }
          : null,
    };
  }

  /** Records the evaluated transaction for future windows; idempotent. */
  async recordActivity(
    db: Pick<PoolClient, 'query'>,
    tx: TransactionFacts,
    amount: string,
  ): Promise<void> {
    await db.query(
      `INSERT INTO account_activity (account_id, transaction_id, amount, merchant_id, country, geo_lat, geo_lon, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [
        tx.accountId,
        tx.transactionId,
        amount,
        tx.merchantId,
        tx.country,
        tx.geo?.lat ?? null,
        tx.geo?.lon ?? null,
        tx.requestedAt,
      ],
    );
    await db.query(
      `INSERT INTO known_merchants (account_id, merchant_id, first_seen) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tx.accountId, tx.merchantId, tx.requestedAt],
    );
  }

  async upsertProfile(
    db: Pick<PoolClient, 'query'>,
    p: AccountProfileUpsertedV1,
    at: string,
  ): Promise<void> {
    await db.query(
      `INSERT INTO account_profiles (account_id, home_country, home_city, risk_tier, credit_limit, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET home_country = EXCLUDED.home_country, home_city = EXCLUDED.home_city,
         risk_tier = EXCLUDED.risk_tier, credit_limit = EXCLUDED.credit_limit, updated_at = EXCLUDED.updated_at
       WHERE account_profiles.updated_at <= EXCLUDED.updated_at`,
      [p.accountId, p.homeCountry, p.homeCity ?? null, p.riskTier, p.creditLimit, at],
    );
  }

  async deleteProfile(db: Pick<PoolClient, 'query'>, accountId: string): Promise<void> {
    await db.query('DELETE FROM account_profiles WHERE account_id = $1', [accountId]);
  }

  /** Deletes activity older than 30 days in batches; returns the rows removed. */
  static async cleanupActivity(pool: Pool, olderThanDays = 30, batch = 10_000): Promise<number> {
    let total = 0;
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM account_activity WHERE ctid IN (
           SELECT ctid FROM account_activity WHERE occurred_at < now() - make_interval(days => $1) LIMIT $2)`,
        [olderThanDays, batch],
      );
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < batch) return total;
    }
  }
}

/** numeric::text may come as "12" or "12.5"; toCents accepts at most 2 decimals. */
function normalizeNumeric(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return fraction ? `${whole}.${fraction.slice(0, 2)}` : whole;
}
