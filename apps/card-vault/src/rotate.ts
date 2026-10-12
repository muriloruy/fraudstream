/**
 * `pnpm vault:rotate` — re-encrypts every card with the active key version (SPEC §6.2,
 * PCI DSS 3.6/3.7). Add VAULT_DEK_V<n+1> to the environment, run this, then retire the
 * old key once no card uses it.
 */
import { existsSync } from 'node:fs';
import { createPool } from '@fraudstream/db';
import { VaultService } from './application/vault.service.js';
import { loadConfig } from './config/config.js';
import { CardsRepository } from './infrastructure/db/cards.repository.js';

const envFile = new URL('../../../.env', import.meta.url);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the repo .env
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const pool = createPool({ connectionString: config.databaseUrl, applicationName: 'vault-rotate' });
try {
  const vault = new VaultService(new CardsRepository(pool), config.keyring, config.hmacKey);
  const rotated = await vault.rotateKeys(pool);
  console.log(`re-encrypted ${rotated} card(s) with key v${config.keyring.activeVersion}`);
} finally {
  await pool.end();
}
