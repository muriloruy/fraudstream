import type { LedgerEntry, TransactionAuthorizationRequestedV1 } from '@fraudstream/contracts';
import type { Pool, PoolClient } from '@fraudstream/db';
import { PermanentError, TransientError } from '@fraudstream/kafka';
import type { BalanceDelta } from '../../domain/journal.js';

type Db = Pick<PoolClient, 'query'>;

export interface ProjectedTransaction {
  accountId: string;
  merchantId: string;
  amount: string;
  currency: string;
}

/** Thrown when a balance row kept changing under us; the whole posting is retried. */
export class BalanceConflictError extends TransientError {
  constructor(ledgerAccount: string, attempts: number) {
    super(`balance of ${ledgerAccount} changed concurrently ${attempts} times`);
    this.name = 'BalanceConflictError';
  }
}

// Contract DEBIT/CREDIT ↔ DB char(1) D/C (SPEC §5.6).
const DIRECTION_TO_DB = { DEBIT: 'D', CREDIT: 'C' } as const;

export const MAX_BALANCE_ATTEMPTS = 5;

export class LedgerRepository {
  /** Called on each version conflict, for the `ledger_balance_conflicts_total` metric. */
  constructor(private readonly onConflict: () => void = () => undefined) {}

  async upsertProjection(db: Db, p: TransactionAuthorizationRequestedV1): Promise<void> {
    await db.query(
      `INSERT INTO pending_transactions
         (transaction_id, account_id, merchant_id, amount, currency, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [
        p.transactionId,
        p.accountId,
        p.merchant.id,
        p.amount.value,
        p.amount.currency,
        p.requestedAt,
      ],
    );
  }

  async findProjection(db: Db, transactionId: string): Promise<ProjectedTransaction | null> {
    const { rows } = await db.query<ProjectedTransaction>(
      `SELECT account_id AS "accountId", merchant_id AS "merchantId",
              amount::text AS amount, currency
         FROM pending_transactions WHERE transaction_id = $1`,
      [transactionId],
    );
    return rows[0] ?? null;
  }

  async journalExists(db: Db, transactionId: string): Promise<boolean> {
    const { rowCount } = await db.query('SELECT 1 FROM journals WHERE transaction_id = $1', [
      transactionId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /** False when the transaction already has a journal (business-level idempotency). */
  async insertJournal(
    db: Db,
    journalId: string,
    transactionId: string,
    postedAt: Date,
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `INSERT INTO journals (journal_id, transaction_id, posted_at) VALUES ($1, $2, $3)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [journalId, transactionId, postedAt],
    );
    return rowCount === 1;
  }

  /** One round trip for all entries; balance is checked by the deferred trigger at commit. */
  async insertEntries(db: Db, journalId: string, entries: readonly LedgerEntry[]): Promise<void> {
    await db.query(
      `INSERT INTO entries (journal_id, ledger_account, direction, amount, currency)
       SELECT $1, * FROM unnest($2::text[], $3::char(1)[], $4::numeric[], $5::char(3)[])`,
      [
        journalId,
        entries.map((e) => e.ledgerAccount),
        entries.map((e) => DIRECTION_TO_DB[e.direction]),
        entries.map((e) => e.amount),
        entries.map((e) => e.currency),
      ],
    );
  }

  /**
   * Optimistic locking (SPEC §6.7): read the version, then update only if it is unchanged.
   * Under READ COMMITTED a concurrent writer makes the UPDATE wait and then match 0 rows; we
   * re-read and try again, up to MAX_BALANCE_ATTEMPTS, then let the runtime retry the posting.
   */
  async applyDelta(db: Db, d: BalanceDelta): Promise<void> {
    await db.query(
      `INSERT INTO balances (ledger_account, currency, balance, version) VALUES ($1, $2, 0, 0)
       ON CONFLICT (ledger_account) DO NOTHING`,
      [d.ledgerAccount, d.currency],
    );
    for (let attempt = 1; attempt <= MAX_BALANCE_ATTEMPTS; attempt++) {
      const { rows } = await db.query<{ currency: string; version: string }>(
        'SELECT currency, version FROM balances WHERE ledger_account = $1',
        [d.ledgerAccount],
      );
      const current = rows[0];
      if (!current) throw new TransientError(`balance row of ${d.ledgerAccount} vanished`);
      if (current.currency !== d.currency) {
        // One currency per ledger account (multi-currency is a non-goal, see design.md).
        throw new PermanentError(
          'invariant',
          `${d.ledgerAccount} holds ${current.currency}, cannot post ${d.currency}`,
        );
      }
      const { rowCount } = await db.query(
        `UPDATE balances SET balance = balance + $2::numeric, version = version + 1
          WHERE ledger_account = $1 AND version = $3`,
        [d.ledgerAccount, d.delta, current.version],
      );
      if (rowCount === 1) return;
      this.onConflict();
    }
    throw new BalanceConflictError(d.ledgerAccount, MAX_BALANCE_ATTEMPTS);
  }

  /** Projection rows outlive their decision by the topic retention plus a day, then go. */
  async purgeProjection(pool: Pool, retentionMs: number): Promise<number> {
    const { rowCount } = await pool.query(
      `DELETE FROM pending_transactions WHERE recorded_at < now() - $1 * interval '1 millisecond'`,
      [retentionMs],
    );
    return rowCount ?? 0;
  }
}
