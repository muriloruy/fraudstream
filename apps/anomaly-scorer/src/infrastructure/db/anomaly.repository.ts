import type { PoolClient } from '@fraudstream/db';
import {
  MODEL_VERSION,
  type Baseline,
  type Contribution,
  type Observation,
  type RiskTier,
} from '../../domain/scoring.js';

type Db = Pick<PoolClient, 'query'>;

interface BaselineRow {
  n: number;
  amount_ewma: number;
  amount_ewm_var: number;
  interarrival_ewma: number;
  interarrival_ewm_var: number;
  hour_histogram: number[];
  last_tx_at: Date;
}

const toBaseline = (r: BaselineRow): Baseline => ({
  n: r.n,
  amount: { mean: r.amount_ewma, variance: r.amount_ewm_var },
  interArrival: { mean: r.interarrival_ewma, variance: r.interarrival_ewm_var },
  hourHistogram: r.hour_histogram,
  lastTxAt: r.last_tx_at.toISOString(),
});

export const KEEP_CONTRIBUTIONS = 50;

export class AnomalyRepository {
  /** Locks the account's baseline row for the rest of the transaction. */
  async lockBaseline(db: Db, accountId: string): Promise<Baseline | null> {
    const { rows } = await db.query<BaselineRow>(
      `SELECT n, amount_ewma, amount_ewm_var, interarrival_ewma, interarrival_ewm_var, hour_histogram, last_tx_at
         FROM account_baselines WHERE account_id = $1 FOR UPDATE`,
      [accountId],
    );
    return rows[0] ? toBaseline(rows[0]) : null;
  }

  async saveBaseline(db: Db, accountId: string, b: Baseline | null): Promise<void> {
    if (!b?.lastTxAt) {
      await db.query('DELETE FROM account_baselines WHERE account_id = $1', [accountId]);
      return;
    }
    await db.query(
      `INSERT INTO account_baselines (account_id, n, amount_ewma, amount_ewm_var, interarrival_ewma, interarrival_ewm_var,
                                      hour_histogram, last_tx_at, model_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (account_id) DO UPDATE SET n = EXCLUDED.n, amount_ewma = EXCLUDED.amount_ewma,
         amount_ewm_var = EXCLUDED.amount_ewm_var, interarrival_ewma = EXCLUDED.interarrival_ewma,
         interarrival_ewm_var = EXCLUDED.interarrival_ewm_var, hour_histogram = EXCLUDED.hour_histogram,
         last_tx_at = EXCLUDED.last_tx_at, model_version = EXCLUDED.model_version, updated_at = now()`,
      [
        accountId,
        b.n,
        b.amount.mean,
        b.amount.variance,
        b.interArrival.mean,
        b.interArrival.variance,
        b.hourHistogram,
        b.lastTxAt,
        MODEL_VERSION,
      ],
    );
  }

  async tierOf(db: Db, accountId: string): Promise<RiskTier> {
    const { rows } = await db.query<{ risk_tier: RiskTier }>(
      'SELECT risk_tier FROM account_profiles WHERE account_id = $1',
      [accountId],
    );
    return rows[0]?.risk_tier ?? 'MEDIUM';
  }

  async upsertTier(db: Db, accountId: string, tier: RiskTier, at: string): Promise<void> {
    await db.query(
      `INSERT INTO account_profiles (account_id, risk_tier, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET risk_tier = EXCLUDED.risk_tier, updated_at = EXCLUDED.updated_at
       WHERE account_profiles.updated_at <= EXCLUDED.updated_at`,
      [accountId, tier, at],
    );
  }

  async deleteProfile(db: Db, accountId: string): Promise<void> {
    await db.query('DELETE FROM account_profiles WHERE account_id = $1', [accountId]);
  }

  /** True if the merchant was new for the account; records it either way. */
  async rememberMerchant(
    db: Db,
    accountId: string,
    merchantId: string,
    at: string,
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      'INSERT INTO known_merchants (account_id, merchant_id, first_seen) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [accountId, merchantId, at],
    );
    return rowCount === 1;
  }

  /** Stores a contribution and keeps only the account's last 50. */
  async addContribution(db: Db, accountId: string, c: Contribution): Promise<void> {
    await db.query(
      `INSERT INTO contributions (account_id, transaction_id, prior, tier, observation) VALUES ($1, $2, $3, $4, $5)`,
      [
        accountId,
        c.transactionId,
        c.prior === null ? null : JSON.stringify(c.prior),
        c.tier,
        JSON.stringify(c.observation),
      ],
    );
    await db.query(
      `DELETE FROM contributions WHERE account_id = $1 AND seq < (
         SELECT min(seq) FROM (SELECT seq FROM contributions WHERE account_id = $1 ORDER BY seq DESC LIMIT $2) AS kept)`,
      [accountId, KEEP_CONTRIBUTIONS],
    );
  }

  async contributionsOf(db: Db, accountId: string): Promise<(Contribution & { seq: string })[]> {
    const { rows } = await db.query<{
      seq: string;
      transaction_id: string;
      prior: Baseline | null;
      tier: RiskTier;
      observation: Observation;
    }>(
      'SELECT seq, transaction_id, prior, tier, observation FROM contributions WHERE account_id = $1 ORDER BY seq',
      [accountId],
    );
    return rows.map((r) => ({
      seq: r.seq,
      transactionId: r.transaction_id,
      prior: r.prior,
      tier: r.tier,
      observation: r.observation,
    }));
  }

  async accountOfContribution(db: Db, transactionId: string): Promise<string | null> {
    const { rows } = await db.query<{ account_id: string }>(
      'SELECT account_id FROM contributions WHERE transaction_id = $1',
      [transactionId],
    );
    return rows[0]?.account_id ?? null;
  }

  async rewritePrior(db: Db, transactionId: string, prior: Baseline | null): Promise<void> {
    await db.query('UPDATE contributions SET prior = $2 WHERE transaction_id = $1', [
      transactionId,
      prior === null ? null : JSON.stringify(prior),
    ]);
  }

  async deleteContribution(db: Db, transactionId: string): Promise<void> {
    await db.query('DELETE FROM contributions WHERE transaction_id = $1', [transactionId]);
  }
}
