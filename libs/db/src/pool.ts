import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

export interface PoolConfig {
  connectionString: string;
  /** Shown in pg_stat_activity, e.g. the service name. */
  applicationName: string;
  max?: number;
}

export function createPool(config: PoolConfig): Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName,
    max: config.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Runs `fn` inside BEGIN/COMMIT on one pooled connection, rolling back if it throws.
 * Every write that must be atomic with an outbox event goes through here (SPEC §4.4, §4.5).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** True when the database answers `SELECT 1` (readiness probes). */
export async function databaseIsReachable(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
