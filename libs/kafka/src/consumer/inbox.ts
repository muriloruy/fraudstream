import type { Pool, PoolClient } from '@fraudstream/db';

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * `<schema>.processed_events` (SPEC §4.4): one row per (consumer group, event id), inserted in
 * the same DB transaction as the handler's side effects.
 */
export class Inbox {
  private readonly claimSql: string;
  private readonly purgeSql: string;

  constructor(schema: string) {
    if (!SCHEMA.test(schema)) throw new RangeError(`invalid schema name "${schema}"`);
    this.claimSql = `INSERT INTO ${schema}.processed_events (consumer_group, event_id)
      VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id`;
    this.purgeSql = `DELETE FROM ${schema}.processed_events WHERE processed_at < now() - $1 * interval '1 millisecond'`;
  }

  /** True the first time an event is seen by this group; false for a duplicate delivery. */
  async claim(tx: PoolClient, group: string, eventId: string): Promise<boolean> {
    const result = await tx.query(this.claimSql, [group, eventId]);
    return result.rowCount === 1;
  }

  /** Deletes rows older than `olderThanMs` (topic retention + 1 day); returns the count. */
  async purge(pool: Pool, olderThanMs: number): Promise<number> {
    const result = await pool.query(this.purgeSql, [olderThanMs]);
    return result.rowCount ?? 0;
  }
}
