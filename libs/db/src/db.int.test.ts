import { fileURLToPath } from 'node:url';
import { startPostgres, type TestPostgres } from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, databaseIsReachable, migrate, withTransaction, type Pool } from './index.js';

let db: TestPostgres;
let pool: Pool;

beforeAll(async () => {
  db = await startPostgres();
  const databaseUrl = db.urlFor('payments_svc');
  const applied = await migrate({
    databaseUrl,
    schema: 'payments',
    dir: fileURLToPath(new URL('./__fixtures__/migrations', import.meta.url)),
  });
  expect(applied).toEqual(['001_widgets']);
  pool = createPool({ connectionString: databaseUrl, applicationName: 'db-test' });
});

afterAll(async () => {
  await pool.end();
  await db.stop();
});

describe('migrate', () => {
  it('creates tables in the service schema and is idempotent', async () => {
    const again = await migrate({
      databaseUrl: db.urlFor('payments_svc'),
      schema: 'payments',
      dir: fileURLToPath(new URL('./__fixtures__/migrations', import.meta.url)),
    });
    expect(again).toEqual([]);
    const { rows } = await pool.query<{ t: string }>(
      "SELECT to_regclass('payments.widgets')::text AS t",
    );
    expect(rows[0]?.t).toBe('widgets');
  });
});

describe('withTransaction', () => {
  it('commits on success', async () => {
    await withTransaction(pool, (c) => c.query("INSERT INTO widgets VALUES (1, 'a')"));
    const { rowCount } = await pool.query('SELECT 1 FROM widgets WHERE id = 1');
    expect(rowCount).toBe(1);
  });

  it('rolls back every statement when the callback throws', async () => {
    await expect(
      withTransaction(pool, async (c) => {
        await c.query("INSERT INTO widgets VALUES (2, 'b')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rowCount } = await pool.query('SELECT 1 FROM widgets WHERE id = 2');
    expect(rowCount).toBe(0);
  });

  it('reports reachability', async () => {
    expect(await databaseIsReachable(pool)).toBe(true);
  });
});
