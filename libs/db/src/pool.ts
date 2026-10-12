import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

export interface PoolConfig {
  connectionString: string;
  /** Shown in pg_stat_activity, e.g. the service name. */
  applicationName: string;
  max?: number;
  /** Errors on idle connections (e.g. the database restarted). Defaults to ignoring them. */
  onIdleError?: (error: Error) => void;
}

/**
 * `.env` connection strings point at `localhost` for tools run on the host. Inside compose,
 * `DATABASE_HOST=postgres` swaps only the host, so credentials stay defined in one place.
 */
export function resolveDatabaseUrl(url: string, host = process.env.DATABASE_HOST): string {
  if (!host) return url;
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.toString();
}

export function createPool(config: PoolConfig): Pool {
  const pool = new pg.Pool({
    connectionString: resolveDatabaseUrl(config.connectionString),
    application_name: config.applicationName,
    max: config.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // Without a listener, an idle connection dropped by the server (restart, failover) emits an
  // unhandled 'error' and crashes the process. The pool already discards that client.
  pool.on('error', (error) => {
    config.onIdleError?.(error);
  });
  return pool;
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
