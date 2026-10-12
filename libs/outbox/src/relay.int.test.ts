import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEnvelope, Topics, uuidv7 } from '@fraudstream/contracts';
import { createPool, migrate, withTransaction, type Pool } from '@fraudstream/db';
import { createProducer, type Producer } from '@fraudstream/kafka';
import {
  readAll,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxRelay, OutboxWriter } from './index.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
const producers: Producer[] = [];

async function newProducer(overrides: Record<string, number> = {}): Promise<Producer> {
  const producer = createProducer(kafka.kafka, overrides);
  await producer.connect();
  producers.push(producer);
  return producer;
}

const unpublished = async () =>
  Number(
    (await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE published_at IS NULL'))
      .rows[0]?.n,
  );

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function writeEvents(count: number, keys: number, topic: string): Promise<void> {
  const writer = new OutboxWriter('payments');
  await withTransaction(pool, async (client) => {
    for (let seq = 0; seq < count; seq++) {
      const accountId = `acc_${seq % keys}`;
      await writer.write(client, {
        topic,
        key: accountId,
        envelope: createEnvelope({
          eventType: 'TestEvent',
          eventVersion: 1,
          producer: 'test',
          correlationId: uuidv7(),
          payload: { seq, accountId },
        }),
      });
    }
  });
}

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  await migrate({
    databaseUrl: db.urlFor('payments_svc'),
    schema: 'payments',
    dir: fileURLToPath(new URL('../../../migrations/payments', import.meta.url)),
  });
  pool = createPool({ connectionString: db.urlFor('payments_svc'), applicationName: 'relay-test' });
});

afterAll(async () => {
  for (const p of producers) await p.disconnect().catch(() => undefined);
  await pool.end();
  await Promise.all([db.stop(), kafka.stop()]);
});

beforeEach(async () => {
  await pool.query('DELETE FROM outbox');
});

describe('OutboxRelay', () => {
  it('two relays publish 1,000 events exactly once, in order per key (SPEC §13.2)', async () => {
    const topic = Topics.transactions;
    await writeEvents(1000, 50, topic);

    const relays = [
      new OutboxRelay({
        pool,
        producer: await newProducer(),
        schema: 'payments',
        batchSize: 100,
        standbyRetryMs: 200,
      }),
      new OutboxRelay({
        pool,
        producer: await newProducer(),
        schema: 'payments',
        batchSize: 100,
        standbyRetryMs: 200,
      }),
    ];
    relays.forEach((r) => {
      r.start();
    });
    await waitFor(async () => (await unpublished()) === 0);
    expect(relays.filter((r) => r.isLeader)).toHaveLength(1);
    await Promise.all(relays.map((r) => r.stop()));

    const messages = await readAll(kafka.kafka, [topic]);
    expect(messages).toHaveLength(1000);
    expect(new Set(messages.map((m) => m.headers['event-id'])).size).toBe(1000);

    // Within a partition, offsets are the publish order: each key's seq must increase.
    const lastSeqByKey = new Map<string, number>();
    const byPartitionOffset = [...messages].sort(
      (a, b) => a.partition - b.partition || Number(BigInt(a.offset) - BigInt(b.offset)),
    );
    for (const message of byPartitionOffset) {
      const { payload } = JSON.parse(message.value ?? '{}') as { payload: { seq: number } };
      const key = message.key ?? '';
      expect(payload.seq).toBeGreaterThan(lastSeqByKey.get(key) ?? -1);
      lastSeqByKey.set(key, payload.seq);
    }
    expect(lastSeqByKey.size).toBe(50);
  });

  it('a standby relay takes over when the leader stops', async () => {
    const a = new OutboxRelay({
      pool,
      producer: await newProducer(),
      schema: 'payments',
      standbyRetryMs: 100,
    });
    const b = new OutboxRelay({
      pool,
      producer: await newProducer(),
      schema: 'payments',
      standbyRetryMs: 100,
    });
    a.start();
    await waitFor(() => Promise.resolve(a.isLeader));
    b.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(b.isLeader).toBe(false);

    await a.stop();
    await writeEvents(10, 2, Topics.ruleResults);
    await waitFor(async () => (await unpublished()) === 0);
    expect(b.isLeader).toBe(true);
    await b.stop();
  });

  it('keeps rows unpublished with attempts while Kafka is down, then publishes them', async () => {
    const producer = await newProducer({ 'message.timeout.ms': 3000 });
    const relay = new OutboxRelay({ pool, producer, schema: 'payments', maxBackoffMs: 500 });
    await writeEvents(5, 5, Topics.scores);

    const id = kafka.container.getId();
    execFileSync('docker', ['pause', id]);
    try {
      await expect(relay.publishBatch()).rejects.toThrow();
      const { rows } = await pool.query<{ attempts: number; last_error: string | null }>(
        'SELECT attempts, last_error FROM outbox',
      );
      expect(rows.every((r) => r.attempts >= 1 && r.last_error !== null)).toBe(true);
      expect(await unpublished()).toBe(5);
    } finally {
      execFileSync('docker', ['unpause', id]);
    }

    relay.start();
    await waitFor(async () => (await unpublished()) === 0);
    await relay.stop();
    const messages = await readAll(kafka.kafka, [Topics.scores]);
    expect(new Set(messages.map((m) => m.headers['event-id'])).size).toBe(5);
  });
});
