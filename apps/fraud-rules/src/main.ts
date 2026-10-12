import { fileURLToPath } from 'node:url';
import { migrate } from '@fraudstream/db';
import { createApp } from './app.js';
import { loadConfig } from './config/config.js';

const config = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') {
  await migrate({
    databaseUrl: config.databaseUrl,
    schema: 'fraud_rules',
    dir:
      process.env.MIGRATIONS_DIR ??
      fileURLToPath(new URL('../../../migrations/fraud_rules', import.meta.url)),
  });
}
const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
