import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { repoPath } from './paths.js';

/** Service roles created by infra/postgres/init-roles.sql. */
export type ServiceRole =
  | 'payments_svc'
  | 'vault_svc'
  | 'fraud_rules_svc'
  | 'anomaly_svc'
  | 'decision_svc'
  | 'ledger_svc'
  | 'alerts_svc'
  | 'reconciler';

const ROLE_PASSWORD = 'test-password';
const PASSWORD_VARS = [
  'payments',
  'vault',
  'fraud_rules',
  'anomaly',
  'decision',
  'ledger',
  'alerts',
  'reconciler',
].flatMap((service) => ['-v', `${service}_password=${ROLE_PASSWORD}`]);

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  /** Superuser connection string, for assertions and dumps only. */
  superuserUrl: string;
  /** Connection string for a least-privilege service role. */
  urlFor(role: ServiceRole): string;
  /** Plain-text `pg_dump` of the database, optionally excluding schemas. */
  dump(excludeSchemas?: readonly string[]): Promise<string>;
  stop(): Promise<void>;
}

/**
 * PostgreSQL 16 with the same schemas and per-service roles as the compose stack
 * (infra/postgres/init-roles.sql), so integration tests exercise real privileges.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('fraudstream')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyFilesToContainer([
      { source: repoPath('infra/postgres/init-roles.sql'), target: '/infra/init-roles.sql' },
    ])
    .start();

  const init = await container.exec([
    'psql',
    '-U',
    'postgres',
    '-d',
    'fraudstream',
    '-v',
    'ON_ERROR_STOP=1',
    ...PASSWORD_VARS,
    '-f',
    '/infra/init-roles.sql',
  ]);
  if (init.exitCode !== 0) {
    throw new Error(`init-roles.sql failed: ${init.output}`);
  }

  const host = container.getHost();
  const port = container.getPort();
  return {
    container,
    superuserUrl: container.getConnectionUri(),
    urlFor: (role) => `postgres://${role}:${ROLE_PASSWORD}@${host}:${port}/fraudstream`,
    async dump(excludeSchemas = []) {
      const result = await container.exec([
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        'fraudstream',
        ...excludeSchemas.flatMap((s) => ['--exclude-schema', s]),
      ]);
      if (result.exitCode !== 0) throw new Error(`pg_dump failed: ${result.output}`);
      return result.stdout;
    },
    async stop() {
      await container.stop();
    },
  };
}
