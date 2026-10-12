import type { Pool } from '@fraudstream/db';
import type { Queryable } from '@fraudstream/outbox';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'in-progress' }
  | { kind: 'mismatch' }
  | { kind: 'replay'; response: StoredResponse };

const IN_PROGRESS = 0;

/** Idempotency-Key bookkeeping (SPEC §5.1). */
export class IdempotencyRepository {
  constructor(private readonly pool: Pool) {}

  /** Atomically claims the key, or reports what an earlier request with it left behind. */
  async claim(key: string, requestHash: string): Promise<ClaimResult> {
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_keys (idempotency_key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, '{}') ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, requestHash, IN_PROGRESS],
    );
    if (inserted.rowCount === 1) return { kind: 'claimed' };

    const { rows } = await this.pool.query<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
    }>(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE idempotency_key = $1',
      [key],
    );
    const row = rows[0];
    // Released between our insert and select: let the client retry.
    if (!row) return { kind: 'in-progress' };
    if (row.request_hash !== requestHash) return { kind: 'mismatch' };
    if (row.response_status === IN_PROGRESS) return { kind: 'in-progress' };
    return { kind: 'replay', response: { status: row.response_status, body: row.response_body } };
  }

  /** Stores the final response; runs inside the transaction that persists the work. */
  async complete(client: Queryable, key: string, response: StoredResponse): Promise<void> {
    await client.query(
      'UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE idempotency_key = $1',
      [key, response.status, JSON.stringify(response.body)],
    );
  }

  /** Frees a key whose request failed before completing, so the client can retry it. */
  async release(key: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM idempotency_keys WHERE idempotency_key = $1 AND response_status = $2',
      [key, IN_PROGRESS],
    );
  }
}
