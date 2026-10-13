import { readFileSync } from 'node:fs';
import {
  createEnvelope,
  FraudDecisionMade,
  LedgerEntriesPosted,
  Topics,
  TransactionAuthorizationRequested,
  uuidv7,
  type Envelope,
  type FraudDecisionMadeV1,
  type TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import { createPool, migrate, withTransaction, type Pool, type PoolClient } from '@fraudstream/db';
import { createProducer, eventHeaders, type Producer } from '@fraudstream/kafka';
import {
  readAll,
  repoPath,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { postApproval } from './application/posting.js';
import { reconcile } from './application/reconciliation.js';
import { loadConfig } from './config/config.js';
import { BalanceConflictError, LedgerRepository } from './infrastructure/db/ledger.repository.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool; // ledger_svc
let superuser: Pool;
let producer: Producer;
let app: Awaited<ReturnType<typeof createApp>>;

const fixture = <P>(name: string) =>
  JSON.parse(readFileSync(repoPath(`libs/contracts/fixtures/${name}.json`), 'utf8')) as Envelope<P>;
const txFixture = fixture<TransactionAuthorizationRequestedV1>(
  'transaction-authorization-requested',
);
const decisionFixture = fixture<FraudDecisionMadeV1>('fraud-decision-made');

function authorization(accountId: string, amount: string, merchantId = 'mer_ledger') {
  const transactionId = uuidv7();
  return createEnvelope({
    eventType: TransactionAuthorizationRequested.eventType,
    eventVersion: 1,
    producer: 'transaction-api',
    correlationId: transactionId,
    payload: {
      ...txFixture.payload,
      transactionId,
      accountId,
      amount: { value: amount, currency: 'BRL' as const },
      merchant: { ...txFixture.payload.merchant, id: merchantId },
      requestedAt: new Date().toISOString(),
    },
  });
}

function decisionFor(
  tx: Envelope<TransactionAuthorizationRequestedV1>,
  decision: FraudDecisionMadeV1['decision'],
) {
  return createEnvelope({
    eventType: FraudDecisionMade.eventType,
    eventVersion: 1,
    producer: 'decision-engine',
    correlationId: tx.payload.transactionId,
    payload: {
      ...decisionFixture.payload,
      transactionId: tx.payload.transactionId,
      accountId: tx.payload.accountId,
      decision,
      decidedAt: new Date().toISOString(),
    },
  });
}

async function publish(topic: string, events: Envelope<{ accountId: string }>[]): Promise<void> {
  await producer.send({
    topic,
    messages: events.map((e) => ({
      key: e.payload.accountId,
      value: JSON.stringify(e),
      headers: eventHeaders(e),
    })),
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const journalsOf = async (transactionId: string) =>
  (
    await pool.query<{ journal_id: string }>(
      'SELECT journal_id FROM journals WHERE transaction_id = $1',
      [transactionId],
    )
  ).rows;
const processed = (eventId: string) =>
  waitFor(async () => {
    const { rowCount } = await pool.query('SELECT 1 FROM processed_events WHERE event_id = $1', [
      eventId,
    ]);
    return rowCount ? true : undefined;
  });
const posted = (transactionId: string) => waitFor(async () => (await journalsOf(transactionId))[0]);
const balanceOf = async (account: string) =>
  (
    await pool.query<{ balance: string }>(
      'SELECT balance::text FROM balances WHERE ledger_account = $1',
      [account],
    )
  ).rows[0]?.balance;

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const url = db.urlFor('ledger_svc');
  await migrate({ databaseUrl: url, schema: 'ledger', dir: repoPath('migrations/ledger') });
  await migrate({
    databaseUrl: db.urlFor('decision_svc'),
    schema: 'decision',
    dir: repoPath('migrations/decision'),
  });
  pool = createPool({ connectionString: url, applicationName: 'test', max: 20 });
  superuser = createPool({ connectionString: db.superuserUrl, applicationName: 'test-su' });
  producer = createProducer(kafka.kafka);
  await producer.connect();
  app = await createApp(
    loadConfig({
      DATABASE_URL_LEDGER: url,
      KAFKA_BROKERS: kafka.brokers.join(','),
      LOG_LEVEL: 'silent',
    }),
    { runtimeOverrides: { inProcessDelaysMs: [100, 200], retryBaseDelayMs: 300 } },
  );
  await app.listen(0, '127.0.0.1');
});

afterAll(async () => {
  await app.close();
  await producer.disconnect();
  await Promise.all([pool.end(), superuser.end()]);
  await Promise.all([db.stop(), kafka.stop()]);
});

describe('ledger invariants in the database (SPEC §5.6)', () => {
  const insertJournal = async (client: PoolClient, debit: string, credit: string) => {
    const journalId = uuidv7();
    await client.query('INSERT INTO journals VALUES ($1, $2, now())', [journalId, uuidv7()]);
    await client.query(
      `INSERT INTO entries (journal_id, ledger_account, direction, amount, currency) VALUES
         ($1, 'customer:inv', 'D', $2, 'BRL'), ($1, 'merchant:inv', 'C', $3, 'BRL')`,
      [journalId, debit, credit],
    );
    return journalId;
  };

  it('accepts a balanced journal at commit', async () => {
    const journalId = await withTransaction(pool, (c) => insertJournal(c, '10.00', '10.00'));
    const { rowCount } = await pool.query('SELECT 1 FROM entries WHERE journal_id = $1', [
      journalId,
    ]);
    expect(rowCount).toBe(2);
  });

  it('rejects an unbalanced journal at commit (debit 10.00, credit 9.99)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const journalId = await insertJournal(client, '10.00', '9.99'); // accepted until COMMIT
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
      const { rowCount } = await pool.query('SELECT 1 FROM journals WHERE journal_id = $1', [
        journalId,
      ]);
      expect(rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK'); // no-op after the failed COMMIT; never release mid-transaction
      client.release();
    }
  });

  it.each([
    'UPDATE entries SET amount = 1',
    'DELETE FROM entries',
    'TRUNCATE entries',
    'UPDATE journals SET posted_at = now()',
    'DELETE FROM journals',
  ])('denies "%s" to ledger_svc: entries are append-only', async (sql) => {
    await expect(pool.query(sql)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('posting approved transactions (SPEC §6.7)', () => {
  it('projects transactions idempotently', async () => {
    const tx = authorization('acc_proj', '12.34');
    await publish(Topics.transactions, [tx, tx]);
    await processed(tx.eventId);
    await new Promise((r) => setTimeout(r, 500));
    const { rows } = await pool.query<{ amount: string; merchant_id: string }>(
      'SELECT amount::text, merchant_id FROM pending_transactions WHERE transaction_id = $1',
      [tx.payload.transactionId],
    );
    expect(rows).toEqual([{ amount: '12.34', merchant_id: 'mer_ledger' }]);
  });

  it('posts one balanced journal for an approval and publishes LedgerEntriesPosted', async () => {
    const tx = authorization('acc_ok', '1250.90', 'mer_ok');
    await publish(Topics.transactions, [tx]);
    await publish(Topics.decisions, [decisionFor(tx, 'APPROVE')]);
    const { journal_id: journalId } = await posted(tx.payload.transactionId);

    const { rows } = await pool.query<{
      ledger_account: string;
      direction: string;
      amount: string;
    }>(
      'SELECT ledger_account, direction, amount::text FROM entries WHERE journal_id = $1 ORDER BY direction DESC',
      [journalId],
    );
    expect(rows).toEqual([
      { ledger_account: 'customer:acc_ok', direction: 'D', amount: '1250.90' },
      { ledger_account: 'merchant:mer_ok', direction: 'C', amount: '1250.90' },
    ]);
    expect(await balanceOf('customer:acc_ok')).toBe('-1250.90');
    expect(await balanceOf('merchant:mer_ok')).toBe('1250.90');

    const message = await waitFor(async () =>
      (await readAll(kafka.kafka, [Topics.ledgerEntries])).find((m) =>
        m.value?.includes(tx.payload.transactionId),
      ),
    );
    const event = LedgerEntriesPosted.envelope.parse(JSON.parse(message.value ?? ''));
    expect(event.payload).toMatchObject({ journalId, accountId: 'acc_ok' });
    expect(event.payload.entries.map((e) => [e.direction, e.amount])).toEqual([
      ['DEBIT', '1250.90'],
      ['CREDIT', '1250.90'],
    ]);
    expect(event.correlationId).toBe(tx.payload.transactionId);
  });

  it.each(['DECLINE', 'REVIEW'] as const)('posts nothing for %s', async (decision) => {
    const tx = authorization(`acc_${decision.toLowerCase()}`, '50.00');
    await publish(Topics.transactions, [tx]);
    const d = decisionFor(tx, decision);
    await publish(Topics.decisions, [d]);
    await processed(d.eventId);
    expect(await journalsOf(tx.payload.transactionId)).toHaveLength(0);
  });

  it('keeps one journal across redeliveries, even after processed_events is cleared', async () => {
    const tx = authorization('acc_dup', '20.00', 'mer_dup');
    const d = decisionFor(tx, 'APPROVE');
    await publish(Topics.transactions, [tx]);
    await publish(Topics.decisions, [d, d, d]);
    await posted(tx.payload.transactionId);

    await superuser.query('DELETE FROM ledger.processed_events WHERE event_id = $1', [d.eventId]);
    await publish(Topics.decisions, [d]);
    await processed(d.eventId); // processed again: the journal guard, not the inbox, stopped it
    expect(await journalsOf(tx.payload.transactionId)).toHaveLength(1);
    expect(await balanceOf('merchant:mer_dup')).toBe('20.00');
  });

  it('waits (retries) when the decision arrives before the transaction', async () => {
    const tx = authorization('acc_late', '7.77', 'mer_late');
    await publish(Topics.decisions, [decisionFor(tx, 'APPROVE')]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await journalsOf(tx.payload.transactionId)).toHaveLength(0);
    await publish(Topics.transactions, [tx]);
    await posted(tx.payload.transactionId);
    expect(await balanceOf('merchant:mer_late')).toBe('7.77');
  });
});

describe('concurrency', () => {
  it('500 concurrent approvals to one merchant: balance equals the sum of credits', async () => {
    const repo = new LedgerRepository();
    let retries = 0;
    const postWithRetry = async (i: number): Promise<void> => {
      const amount = `${(i % 97) + 1}.${String(i % 100).padStart(2, '0')}`;
      const tx = {
        transactionId: uuidv7(),
        accountId: `acc_c${i % 50}`,
        merchantId: 'mer_hot',
        amount,
        currency: 'BRL',
      };
      for (;;) {
        try {
          await withTransaction(pool, (c) => postApproval(c, repo, tx));
          return;
        } catch (error) {
          // What the consumer runtime does with a transient error: run the posting again.
          if (!(error instanceof BalanceConflictError)) throw error;
          retries++;
        }
      }
    };
    await Promise.all(Array.from({ length: 500 }, (_, i) => postWithRetry(i)));

    const { rows } = await pool.query<{ balance: string; credits: string; journals: string }>(
      `SELECT b.balance::text,
              (SELECT sum(amount)::text FROM entries WHERE ledger_account = 'merchant:mer_hot' AND direction = 'C') AS credits,
              (SELECT count(*)::text FROM entries WHERE ledger_account = 'merchant:mer_hot') AS journals
         FROM balances b WHERE b.ledger_account = 'merchant:mer_hot'`,
    );
    expect(rows[0]?.journals).toBe('500');
    expect(rows[0]?.balance).toBe(rows[0]?.credits);
    const { rows: version } = await pool.query<{ version: string }>(
      "SELECT version::text FROM balances WHERE ledger_account = 'merchant:mer_hot'",
    );
    expect(version[0]?.version).toBe('500'); // one successful versioned update per posting
    expect(retries).toBeGreaterThanOrEqual(0);
  });
});

describe('reconciliation (docs/sql/reconciliation.sql)', () => {
  let reconciler: Pool;

  beforeAll(() => {
    reconciler = createPool({
      connectionString: db.urlFor('reconciler'),
      applicationName: 'test-rec',
    });
  });
  afterAll(() => reconciler.end());

  const seedDecision = (transactionId: string, accountId: string) =>
    superuser.query(
      `INSERT INTO decision.decisions VALUES ($1, $2, 'APPROVE', 0.1, 0.1, 0.1, false, '{}', 'fusion-test', 10, now())`,
      [transactionId, accountId],
    );

  it('reports a clean ledger after a seeded run, and a dirty one when a journal disappears', async () => {
    const txs = [
      authorization('acc_rec1', '10.00', 'mer_rec'),
      authorization('acc_rec2', '0.01', 'mer_rec'),
    ];
    await publish(Topics.transactions, txs);
    await publish(
      Topics.decisions,
      txs.map((t) => decisionFor(t, 'APPROVE')),
    );
    for (const t of txs) {
      await posted(t.payload.transactionId);
      await seedDecision(t.payload.transactionId, t.payload.accountId);
    }

    const clean = await reconcile(reconciler, { graceSeconds: 0 });
    expect(clean).toMatchObject({
      unbalancedJournals: [],
      approvedWithoutJournal: [],
      balanceDrift: [],
      clean: true,
    });
    expect(clean.netBalancePerCurrency).toEqual([
      expect.objectContaining({ currency: 'BRL', net: '0.00' }),
    ]);

    // Tampering only a superuser can do: entries are append-only for the service role, and the
    // foreign key check (run as the owner) cannot lock them either, so FK triggers are disabled.
    const [victim] = txs;
    if (!victim) throw new Error('fixture missing');
    await withTransaction(superuser, async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      const { rows } = await c.query<{ journal_id: string }>(
        'DELETE FROM ledger.journals WHERE transaction_id = $1 RETURNING journal_id',
        [victim.payload.transactionId],
      );
      await c.query('DELETE FROM ledger.entries WHERE journal_id = $1', [rows[0]?.journal_id]);
    });
    const dirty = await reconcile(reconciler, { graceSeconds: 0 });
    expect(dirty.clean).toBe(false);
    expect(dirty.approvedWithoutJournal).toEqual([
      expect.objectContaining({ transaction_id: victim.payload.transactionId }),
    ]);
    expect(dirty.balanceDrift.map((r) => r.ledger_account)).toEqual(
      expect.arrayContaining(['customer:acc_rec1', 'merchant:mer_rec']),
    );
  });

  it('honours the grace period for decisions the ledger has not posted yet', async () => {
    const tx = authorization('acc_grace', '5.00');
    await seedDecision(tx.payload.transactionId, tx.payload.accountId);
    const report = await reconcile(reconciler, { graceSeconds: 300 });
    expect(report.approvedWithoutJournal.map((r) => r.transaction_id)).not.toContain(
      tx.payload.transactionId,
    );
  });

  it('runs as a read-only role', async () => {
    await expect(
      reconciler.query("INSERT INTO ledger.balances VALUES ('x', 'BRL', 0, 0)"),
    ).rejects.toThrow();
    await expect(
      reconciler.query('SELECT 1 FROM ledger.pending_transactions'),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });
});
