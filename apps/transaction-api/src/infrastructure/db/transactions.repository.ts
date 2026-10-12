import type { TransactionAuthorizationRequestedV1 } from '@fraudstream/contracts';
import type { Pool } from '@fraudstream/db';
import type { Queryable } from '@fraudstream/outbox';

export interface TransactionView {
  transactionId: string;
  accountId: string;
  status: 'PENDING' | 'APPROVED' | 'REVIEW' | 'DECLINED';
  maskedPan: string;
  amount: { value: string; currency: string };
  merchant: { id: string; mcc: string; country: string };
  channel: string;
  finalScore: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

interface TransactionRow {
  transaction_id: string;
  account_id: string;
  status: TransactionView['status'];
  masked_pan: string;
  amount: string;
  currency: string;
  merchant_id: string;
  merchant_mcc: string;
  merchant_country: string;
  channel: string;
  final_score: string | null;
  requested_at: Date;
  decided_at: Date | null;
}

export class TransactionsRepository {
  constructor(private readonly pool: Pool) {}

  async insertPending(client: Queryable, tx: TransactionAuthorizationRequestedV1): Promise<void> {
    await client.query(
      `INSERT INTO transactions (transaction_id, account_id, card_token, masked_pan, amount, currency,
                                 merchant_id, merchant_mcc, merchant_country, channel, status, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11)`,
      [
        tx.transactionId,
        tx.accountId,
        tx.cardToken,
        tx.maskedPan,
        tx.amount.value, // decimal string straight into numeric(18,2): no float on the way
        tx.amount.currency,
        tx.merchant.id,
        tx.merchant.mcc,
        tx.merchant.country,
        tx.channel,
        tx.requestedAt,
      ],
    );
  }

  async findById(transactionId: string): Promise<TransactionView | null> {
    const { rows } = await this.pool.query<TransactionRow>(
      `SELECT transaction_id, account_id, status, masked_pan, amount, currency, merchant_id,
              merchant_mcc, merchant_country, channel, final_score, requested_at, decided_at
         FROM transactions WHERE transaction_id = $1`,
      [transactionId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      transactionId: r.transaction_id,
      accountId: r.account_id,
      status: r.status,
      maskedPan: r.masked_pan,
      amount: { value: r.amount, currency: r.currency },
      merchant: { id: r.merchant_id, mcc: r.merchant_mcc, country: r.merchant_country },
      channel: r.channel,
      finalScore: r.final_score,
      requestedAt: r.requested_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null,
    };
  }

  /** Keeps monthly partitions ahead of time (current + next 2 months). */
  async ensurePartitions(): Promise<void> {
    await this.pool.query('SELECT ensure_monthly_partitions(current_date, 3)');
  }
}
