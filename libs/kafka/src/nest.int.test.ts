import { readFileSync } from 'node:fs';
import { createEnvelope, dlqTopic, retryTopic, uuidv7 } from '@fraudstream/contracts';
import { createPool, type Pool } from '@fraudstream/db';
import {
  repoPath,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ExampleConsumerAppModule } from '../examples/consumer-app.js';
import type { Producer } from './client.js';
import { ConsumerRuntime } from './consumer/runtime.js';
import { eventHeaders } from './headers.js';
import { consumerToken } from './nest.js';
import { createProducer } from './producer.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
let producer: Producer;

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka([])]);
  pool = createPool({ connectionString: db.urlFor('payments_svc'), applicationName: 'nest-test' });
  const inbox = readFileSync(repoPath('migrations/_templates/processed_events.sql'), 'utf8');
  await pool.query(inbox.split('-- Down Migration')[0] ?? '');
  await pool.query(
    'CREATE TABLE effects (event_id uuid NOT NULL, key text NOT NULL, n int NOT NULL)',
  );
  producer = createProducer(kafka.kafka);
  await producer.connect();
});

afterAll(async () => {
  await producer.disconnect();
  await pool.end();
  await Promise.all([db.stop(), kafka.stop()]);
});

it('KafkaConsumerModule starts the runtime on bootstrap and stops it on close', async () => {
  const topic = 'nest.example.v1';
  const group = 'g-nest';
  const admin = kafka.kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [topic, retryTopic(topic, group), dlqTopic(topic, group)].map((t) => ({
      topic: t,
      numPartitions: 1,
      replicationFactor: 1,
    })),
  });
  await admin.disconnect();

  const app = await NestFactory.createApplicationContext(
    ExampleConsumerAppModule.forRoot({ kafka: kafka.kafka, pool, producer, topic, group }),
    { logger: false },
  );
  await app.init();
  expect(app.get(consumerToken('effects'))).toBeInstanceOf(ConsumerRuntime);

  const e = createEnvelope({
    eventType: 'TestHappened',
    eventVersion: 1,
    producer: 'test',
    correlationId: uuidv7(),
    payload: { key: 'acc_1', n: 7 },
  });
  await producer.send({
    topic,
    messages: [{ key: 'acc_1', value: JSON.stringify(e), headers: eventHeaders(e) }],
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    const { rows } = await pool.query('SELECT 1 FROM effects WHERE event_id = $1', [e.eventId]);
    if (rows.length === 1) break;
    if (Date.now() > deadline) throw new Error('event not processed');
    await new Promise((r) => setTimeout(r, 200));
  }
  await app.close(); // OnApplicationShutdown -> runtime.stop()
});
