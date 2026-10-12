import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from '@fraudstream/db';

export const RECONCILIATION_SQL = fileURLToPath(
  new URL('../../../../docs/sql/reconciliation.sql', import.meta.url),
);

export type Row = Record<string, unknown>;

export interface ReconciliationReport {
  unbalancedJournals: Row[];
  approvedWithoutJournal: Row[];
  netBalancePerCurrency: { currency: string; net: string; accounts: string }[];
  balanceDrift: Row[];
  clean: boolean;
}

const NAMES = {
  unbalanced_journals: 'unbalancedJournals',
  approved_without_journal: 'approvedWithoutJournal',
  net_balance_per_currency: 'netBalancePerCurrency',
  balance_drift: 'balanceDrift',
} as const;
type QueryName = keyof typeof NAMES;

/** numeric arrives as a string: compare textually, no floating point (ADR-009). */
const isZero = (value: string): boolean => value.replace(/[-.0]/g, '') === '';

/** Splits the file on its `-- name:` markers, keeping the order of the queries. */
export function parseQueries(sql: string): { name: QueryName; text: string }[] {
  const parts = sql.split(/^-- name: (\w+)$/m);
  const queries: { name: QueryName; text: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts.at(i);
    const text = parts.at(i + 1)?.trim();
    if (!name || !(name in NAMES) || !text) throw new Error(`unexpected query block "${name}"`);
    queries.push({ name: name as QueryName, text });
  }
  return queries;
}

/**
 * Runs docs/sql/reconciliation.sql in one read-only transaction, so every query sees the
 * same snapshot (REPEATABLE READ). The SQL is a fixed file, never built from input.
 */
export async function reconcile(
  pool: Pool,
  options: { graceSeconds?: number; sqlFile?: string } = {},
): Promise<ReconciliationReport> {
  const sqlFile = options.sqlFile ?? RECONCILIATION_SQL;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo file (or a test override)
  const queries = parseQueries(readFileSync(sqlFile, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('reconcile.grace_seconds', $1, true)", [
      String(options.graceSeconds ?? 300),
    ]);
    const report: Partial<Record<(typeof NAMES)[QueryName], Row[]>> = {};
    for (const q of queries) {
      report[NAMES[q.name]] = (await client.query<Row>(q.text)).rows;
    }
    await client.query('COMMIT');
    const net = (report.netBalancePerCurrency ??
      []) as ReconciliationReport['netBalancePerCurrency'];
    return {
      unbalancedJournals: report.unbalancedJournals ?? [],
      approvedWithoutJournal: report.approvedWithoutJournal ?? [],
      netBalancePerCurrency: net,
      balanceDrift: report.balanceDrift ?? [],
      clean:
        (report.unbalancedJournals ?? []).length === 0 &&
        (report.approvedWithoutJournal ?? []).length === 0 &&
        (report.balanceDrift ?? []).length === 0 &&
        net.every((n) => isZero(n.net)),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
