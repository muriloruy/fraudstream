/**
 * `pnpm ledger:reconcile [--grace <seconds>]` — runs docs/sql/reconciliation.sql as the
 * read-only `reconciler` role and prints a JSON report; exits 1 when the ledger is not clean.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPool } from '@fraudstream/db';
import { reconcile } from './application/reconciliation.js';

const envFile = new URL('../../../.env', import.meta.url);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the repo .env
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { grace: { type: 'string', default: '300' } } });
const graceSeconds = Number(values.grace);
if (!Number.isInteger(graceSeconds) || graceSeconds < 0) throw new Error('--grace must be seconds');

const url = process.env.DATABASE_URL_RECONCILER;
if (!url) throw new Error('DATABASE_URL_RECONCILER is not set (see .env.example)');
const pool = createPool({ connectionString: url, applicationName: 'ledger-reconcile' });
try {
  const report = await reconcile(pool, { graceSeconds });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.clean ? 0 : 1;
} finally {
  await pool.end();
}
