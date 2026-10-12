import { createEnvelope, EventHeaders, Topics, uuidv7 } from '@fraudstream/contracts';
import { createProducer, eventHeaders, sendMessages } from '@fraudstream/kafka';
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
  it('round-trips a message with all seven standard headers (SPEC §4.2)', async () => {
    const envelope = createEnvelope({
      eventType: 'Test',
      eventVersion: 1,
      producer: 'test',
      correlationId: uuidv7(),
      causationId: uuidv7(),
      payload: { hello: 1 },
    });
    const headers = eventHeaders(envelope);
    const producer = createProducer(kafka.kafka);
    await producer.connect();
    await sendMessages(producer, Topics.transactions, [
      { key: 'acc_1', value: JSON.stringify(envelope), headers },
    ]);
    await producer.disconnect();
    const messages = await readAll(kafka.kafka, [Topics.transactions]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.key).toBe('acc_1');
    expect(messages[0]?.headers).toEqual(headers);
    expect(Object.keys(messages[0]?.headers ?? {}).sort()).toEqual(
      Object.values(EventHeaders).sort(),
    );
  });
});
