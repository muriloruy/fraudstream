import { runner } from 'node-pg-migrate';

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
    databaseUrl: options.databaseUrl,
    dir: options.dir,
    direction: 'up',
    count: Infinity,
    schema: options.schema,
    migrationsSchema: options.schema,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    log: options.log ?? (() => undefined),
  });
  return applied.map((m) => m.name);
}
