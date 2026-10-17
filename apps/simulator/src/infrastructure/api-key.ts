import { createHash, randomBytes } from 'node:crypto';
import { createPool } from '@fraudstream/db';

/**
 * Registers a fresh API key for the simulator in `payments.api_keys` (only its SHA-256 is
 * stored, like `pnpm apikey:create`). Used when SIM_API_KEY is not set.
 */
export async function createSimulatorApiKey(databaseUrl: string): Promise<string> {
  const key = `fsk_${randomBytes(32).toString('base64url')}`;
  const pool = createPool({ connectionString: databaseUrl, applicationName: 'simulator' });
  try {
    await pool.query(
      `INSERT INTO api_keys (key_id, name, key_hash) VALUES (gen_random_uuid(), 'simulator', $1)`,
      [createHash('sha256').update(key).digest('hex')],
    );
  } finally {
    await pool.end();
  }
  return key;
}
