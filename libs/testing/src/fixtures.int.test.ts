import { Topics } from '@fraudstream/contracts';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAll, startKafka, startPostgres, type TestKafka, type TestPostgres } from './index.js';

let db: TestPostgres;
let kafka: TestKafka;

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
});

afterAll(async () => {
  await Promise.all([db.stop(), kafka.stop()]);
});

describe('startPostgres', () => {
  it('applies per-service roles: own schema writable, other schemas denied', async () => {
    const client = new pg.Client({ connectionString: db.urlFor('payments_svc') });
    await client.connect();
    try {
      await client.query('CREATE TABLE probe (id int)');
      const { rows } = await client.query<{ s: string }>('SELECT current_schema() AS s');
      expect(rows[0]?.s).toBe('payments');
      await expect(client.query('CREATE TABLE vault.probe (id int)')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client.end();
    }
  });
});

describe('startKafka', () => {
  it('creates catalogued topics and round-trips a keyed message', async () => {
    const admin = kafka.kafka.admin();
    await admin.connect();
    expect(await admin.listTopics()).toContain(Topics.transactions);
    await admin.disconnect();

    const producer = kafka.kafka.producer();
    await producer.connect();
    await producer.send({
      topic: Topics.transactions,
      messages: [{ key: 'acc_1', value: '{"hello":1}', headers: { 'event-id': 'e1' } }],
    });
    await producer.disconnect();
    const messages = await readAll(kafka.kafka, [Topics.transactions]);
    expect(messages).toEqual([
      expect.objectContaining({
        key: 'acc_1',
        value: '{"hello":1}',
        headers: { 'event-id': 'e1' },
      }),
    ]);
  });
});
