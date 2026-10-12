import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createEnvelope, dlqTopic, retryTopic, uuidv7 } from '@fraudstream/contracts';
import { createPool, type Pool } from '@fraudstream/db';
import { createMetricsRegistry } from '@fraudstream/observability';
import {
  REPO_ROOT,
  repoPath,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEvent } from '../__fixtures__/test-event.js';
import { eventHeaders } from '../headers.js';
import { createProducer } from '../producer.js';
import type { Producer } from '../client.js';
import { ConsumerRuntime, on } from './runtime.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
let producer: Producer;

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka([])]);
  pool = createPool({
    connectionString: db.urlFor('payments_svc'),
    applicationName: 'lifecycle-test',
  });
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

let seq = 0;
async function setup(group: string): Promise<{ topic: string; eventId: string }> {
  const topic = `lifecycle.t${++seq}.v1`;
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
  const e = createEnvelope({
    eventType: 'TestHappened',
    eventVersion: 1,
    producer: 'test',
    correlationId: uuidv7(),
    payload: { key: 'acc_1', n: 1 },
  });
  await producer.send({
    topic,
    messages: [{ key: 'acc_1', value: JSON.stringify(e), headers: eventHeaders(e) }],
  });
  return { topic, eventId: e.eventId };
}

interface Child {
  process: ChildProcess;
  output: string[];
  exit: Promise<number | null>;
}

function spawnConsumer(mode: string, topic: string, group: string): Child {
  const child = spawn(
    repoPath('node_modules/.bin/tsx'),
    [
      '--tsconfig',
      repoPath('tsconfig.runtime.json'),
      '--conditions=@fraudstream/source',
      repoPath('libs/kafka/src/__fixtures__/child-consumer.ts'),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        MODE: mode,
        TOPIC: topic,
        GROUP: group,
        DATABASE_URL: db.urlFor('payments_svc'),
        KAFKA_BROKERS: kafka.brokers.join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output: string[] = [];
  child.stdout.on('data', (c: Buffer) => output.push(c.toString()));
  child.stderr.on('data', (c: Buffer) => output.push(c.toString()));
  const exit = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      resolve(code);
    }),
  );
  return { process: child, output, exit };
}

async function waitForOutput(child: Child, text: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!child.output.join('').includes(text)) {
    if (Date.now() > deadline || child.process.exitCode !== null) {
      throw new Error(`no "${text}" in output:\n${child.output.join('').slice(-1500)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const effects = async (eventId: string) =>
  Number(
    (
      await pool.query<{ n: string }>('SELECT count(*) AS n FROM effects WHERE event_id = $1', [
        eventId,
      ])
    ).rows[0]?.n,
  );

/** Starts an in-test consumer on the group and reports how it saw the topic's messages. */
async function drainWithFreshConsumer(topic: string, group: string): Promise<string> {
  const registry = createMetricsRegistry('verify', false);
  const r = new ConsumerRuntime({
    kafka: kafka.kafka,
    pool,
    producer,
    group,
    schema: 'payments',
    registry,
    handlers: [on(testEvent(topic), () => Promise.resolve())],
  });
  await r.start();
  await new Promise((resolve) => setTimeout(resolve, 8000));
  await r.stop();
  return registry.metrics();
}

describe('consumer lifecycle (SPEC §4.3)', () => {
  it('SIGTERM mid-message: finishes it, commits the offset and exits 0', async () => {
    const group = 'g-sigterm';
    const { topic, eventId } = await setup(group);
    const child = spawnConsumer('slow', topic, group);
    await waitForOutput(child, `PROCESSING ${eventId}`);
    child.process.kill('SIGTERM');

    expect(await child.exit).toBe(0);
    expect(child.output.join('')).toContain(`HANDLED ${eventId}`);
    expect(child.output.join('')).toContain('STOPPED');
    expect(await effects(eventId)).toBe(1);
    // The offset was committed: a new member of the group does not receive the message again.
    const metrics = await drainWithFreshConsumer(topic, group);
    expect(metrics).not.toContain('kafka_consumer_messages_total{');
  });

  it('a crash before the DB commit loses nothing: the message is processed once after restart', async () => {
    const group = 'g-crash';
    const { topic, eventId } = await setup(group);
    const crashing = spawnConsumer('crash', topic, group);
    await waitForOutput(crashing, `PROCESSING ${eventId}`);
    expect(await crashing.exit).toBe(1);
    expect(await effects(eventId)).toBe(0); // the open transaction was rolled back

    const restarted = spawnConsumer('normal', topic, group);
    await waitForOutput(restarted, `HANDLED ${eventId}`);
    restarted.process.kill('SIGTERM');
    expect(await restarted.exit).toBe(0);
    expect(await effects(eventId)).toBe(1);
  });
});
