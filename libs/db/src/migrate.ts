import { runner } from 'node-pg-migrate';
import { resolveDatabaseUrl } from './pool.js';

export interface MigrateOptions {
  databaseUrl: string;
  /** The service schema; also holds the `pgmigrations` bookkeeping table. */
  schema: string;
  /** Directory with `NNN_name.sql` files using `-- Up Migration` / `-- Down Migration` markers. */
  dir: string;
  log?: (message: string) => void;
}

/**
 * Applies pending SQL migrations of one service, connected as that service's own role
 * so migrations can only touch its schema (SPEC §5, migrations/<service>/).
 */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const applied = await runner({
    databaseUrl: resolveDatabaseUrl(options.databaseUrl),
    dir: options.dir,
    direction: 'up',
    count: Infinity,
    schema: options.schema,
    migrationsSchema: options.schema,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    // One advisory lock per schema: services own disjoint schemas, so they migrate in parallel
    // at startup; replicas of the same service wait for each other instead of crashing.
    lockValue: schemaLockValue(options.schema),
    advisoryLockMode: 'wait',
    log: options.log ?? (() => undefined),
  });
  return applied.map((m) => m.name);
}

/** Stable 32-bit advisory lock key for a schema name (FNV-1a). */
export function schemaLockValue(schema: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < schema.length; i++) {
    hash ^= schema.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}
