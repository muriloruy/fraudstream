/**
 * `pnpm eval [--ground-truth <csv>] [--title <text>] [--no-write]` (SPEC §9.1): joins the
 * simulator's ground truth with `decision.decisions` (read through the read-only
 * `reconciler` role) and prints precision, recall, F1, review/decline rates and the false
 * positive rate per scenario. The table is appended to docs/model.md under the model,
 * ruleset and decision config versions.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MODEL_VERSION } from '@fraudstream/anomaly-scorer/contract';
import { createPool } from '@fraudstream/db';
import {
  checkTargets,
  evaluate,
  parseGroundTruth,
  toMarkdown,
  topReasons,
  type Decision,
} from '@fraudstream/simulator/evaluation';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
  options: {
    'ground-truth': { type: 'string', default: 'simulator_output/ground_truth.csv' },
    title: { type: 'string' },
    'no-write': { type: 'boolean', default: false },
  },
});

const csvPath = resolve(root, values['ground-truth']);
if (!existsSync(csvPath)) throw new Error(`no ground truth at ${csvPath}: run pnpm sim:run first`);
const truth = parseGroundTruth(readFileSync(csvPath, 'utf8'));

const url = process.env.DATABASE_URL_RECONCILER;
if (!url) throw new Error('DATABASE_URL_RECONCILER is not set (see .env.example)');
const pool = createPool({ connectionString: url, applicationName: 'eval' });
const decisions = new Map<string, Decision>();
const explained = new Map<string, { decision: Decision; reasons: string[] }>();
const configVersions = new Set<string>();
try {
  const ids = truth.map((t) => t.transactionId);
  for (let i = 0; i < ids.length; i += 5000) {
    const { rows } = await pool.query<{
      id: string;
      decision: Decision;
      reasons: string[];
      config_version: string;
    }>(
      `SELECT transaction_id::text AS id, decision, reasons, config_version
         FROM decisions WHERE transaction_id = ANY($1::uuid[])`,
      [ids.slice(i, i + 5000)],
    );
    for (const row of rows) {
      decisions.set(row.id, row.decision);
      explained.set(row.id, { decision: row.decision, reasons: row.reasons });
      configVersions.add(row.config_version);
    }
  }
} finally {
  await pool.end();
}

const rules = readFileSync(resolve(root, 'apps/fraud-rules/rules.yaml'), 'utf8');
const rulesetVersion = /^version:\s*'?([^'\n]+)'?/m.exec(rules)?.[1] ?? 'unknown';
const report = evaluate(truth, decisions);
const markdown = toMarkdown(report, {
  title: values.title ?? `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  details: [
    `model \`${MODEL_VERSION}\`, ruleset \`${rulesetVersion}\`, decision config ` +
      ([...configVersions].map((v) => `\`${v}\``).join(', ') || '—'),
    `${truth.length} labeled transactions from \`${values['ground-truth']}\``,
  ],
  reasons: topReasons(truth, explained),
});
console.log(markdown);

if (!values['no-write']) {
  const modelDoc = resolve(root, 'docs/model.md');
  const doc = readFileSync(modelDoc, 'utf8');
  writeFileSync(modelDoc, `${doc.trimEnd()}\n\n${markdown}`);
  console.log(`appended to docs/model.md`);
}
process.exitCode = checkTargets(report).every((t) => t.met) ? 0 : 1;
