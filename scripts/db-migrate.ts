/**
 * Applies every service's pending migrations (migrations/<service>/), each connected as
 * the service's own least-privilege role so it can only change its own schema (SPEC §5).
 *
 * Usage: pnpm db:migrate [service...]   (reads .env when present)
 */
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from '@fraudstream/db';

interface ServiceDb {
  schema: string;
  urlEnv: string;
}

const SERVICES: Record<string, ServiceDb> = {
  payments: { schema: 'payments', urlEnv: 'DATABASE_URL_PAYMENTS' },
  vault: { schema: 'vault', urlEnv: 'DATABASE_URL_VAULT' },
  fraud_rules: { schema: 'fraud_rules', urlEnv: 'DATABASE_URL_FRAUD_RULES' },
  anomaly: { schema: 'anomaly', urlEnv: 'DATABASE_URL_ANOMALY' },
  decision: { schema: 'decision', urlEnv: 'DATABASE_URL_DECISION' },
  ledger: { schema: 'ledger', urlEnv: 'DATABASE_URL_LEDGER' },
  alerts: { schema: 'alerts', urlEnv: 'DATABASE_URL_ALERTS' },
};

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const requested = process.argv.slice(2);
const services = requested.length > 0 ? requested : Object.keys(SERVICES);

for (const name of services) {
  const service = SERVICES[name];
  if (!service) throw new Error(`unknown service "${name}"`);
  const dir = `${root}migrations/${name}`;
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith('.sql'))) continue;
  const databaseUrl = process.env[service.urlEnv];
  if (!databaseUrl) throw new Error(`${service.urlEnv} is not set`);
  const applied = await migrate({ databaseUrl, schema: service.schema, dir });
  console.log(`${name}: ${applied.length === 0 ? 'up to date' : `applied ${applied.join(', ')}`}`);
}
