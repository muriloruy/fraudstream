/**
 * `pnpm --filter @fraudstream/transaction-api apikey:create <name>` — creates a client API
 * key and prints it once. Only its SHA-256 is stored.
 */
import { existsSync } from 'node:fs';
import { createPool } from '@fraudstream/db';
import { ApiKeysRepository } from './infrastructure/db/api-keys.repository.js';

const envFile = new URL('../../../.env', import.meta.url);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the repo .env
if (existsSync(envFile)) process.loadEnvFile(envFile);

const name = process.argv[2] ?? 'default';
const url = process.env.DATABASE_URL_PAYMENTS;
if (!url) throw new Error('DATABASE_URL_PAYMENTS is not set');
const pool = createPool({ connectionString: url, applicationName: 'apikey-create' });
try {
  const { keyId, key } = await new ApiKeysRepository(pool).create(name);
  console.log(`API key "${name}" (${keyId}):\n${key}\nStore it now; it cannot be shown again.`);
} finally {
  await pool.end();
}
