import { fileURLToPath } from 'node:url';
import { migrate } from '@fraudstream/db';
import { createApp } from './app.js';
import { loadConfig } from './config/config.js';

const config = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') {
  // Compose runs each service's own migrations as its own role at startup.
  await migrate({
    databaseUrl: config.databaseUrl,
    schema: 'vault',
    dir:
      process.env.MIGRATIONS_DIR ??
      fileURLToPath(new URL('../../../migrations/vault', import.meta.url)),
  });
}
const app = await createApp(config);
// Internal network only: compose publishes no port for the vault (SPEC §6.2).
await app.listen(config.port, '0.0.0.0');
