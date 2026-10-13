import { fileURLToPath } from 'node:url';
import { migrate } from '@fraudstream/db';
import { createApp } from './app.js';
import { loadConfig } from './config/config.js';

const config = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') {
  // alerts_svc owns two schemas (SPEC §5.7), each with its own migration history.
  for (const schema of ['auth', 'alerts'] as const) {
    await migrate({
      databaseUrl: config.databaseUrl,
      schema,
      dir:
        (schema === 'alerts' ? process.env.MIGRATIONS_DIR : process.env.AUTH_MIGRATIONS_DIR) ??
        fileURLToPath(new URL(`../../../migrations/${schema}`, import.meta.url)),
    });
  }
}
const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
