/**
 * `pnpm users:seed` — creates or resets the demo users (`analyst@demo.local`,
 * `admin@demo.local`) with the passwords from DEMO_ANALYST_PASSWORD / DEMO_ADMIN_PASSWORD.
 * Re-running resets their passwords and clears any lockout.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPool } from '@fraudstream/db';
import { hashPassword } from './auth/passwords.js';
import { UsersRepository } from './infrastructure/db/users.repository.js';

const envFile = new URL('../../../.env', import.meta.url);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the repo .env
if (existsSync(envFile)) process.loadEnvFile(envFile);

const users = [
  { email: 'analyst@demo.local', role: 'analyst', passwordEnv: 'DEMO_ANALYST_PASSWORD' },
  { email: 'admin@demo.local', role: 'admin', passwordEnv: 'DEMO_ADMIN_PASSWORD' },
] as const;

const url = process.env.DATABASE_URL_ALERTS;
if (!url) throw new Error('DATABASE_URL_ALERTS is not set');
const pool = createPool({ connectionString: url, applicationName: 'users-seed' });
try {
  const repo = new UsersRepository();
  for (const u of users) {
    const password = process.env[u.passwordEnv];
    if (!password || password.length < 12) {
      throw new Error(
        `${u.passwordEnv} must be set to at least 12 characters (pnpm env:init does it)`,
      );
    }
    await repo.upsertUser(pool, {
      userId: randomUUID(),
      email: u.email,
      passwordHash: await hashPassword(password),
      role: u.role,
    });
    console.log(`${u.role}: ${u.email}`);
  }
} finally {
  await pool.end();
}
