import { readFileSync } from 'node:fs';
import {
  createEnvelope,
  DlqHeaders,
  dlqTopic,
  retryTopic,
  uuidv7,
  type Envelope,
  type TopicSpec,
} from '@fraudstream/contracts';
import { createPool, type Pool } from '@fraudstream/db';
import { createMetricsRegistry } from '@fraudstream/observability';
import {
  readAll,
  repoPath,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testEvent, type TestPayload } from '../__fixtures__/test-event.js';
import { eventHeaders } from '../headers.js';
import { createProducer } from '../producer.js';
import type { Producer } from '../client.js';
import { ConsumerRuntime, on, type ConsumerRuntimeOptions } from './runtime.js';
import { TransientError } from './errors.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
let producer: Producer;
// One long-lived admin client: creating and destroying librdkafka clients every poll while a
// consumer group is joining crashed the process (SIGSEGV in the native binding).
let admin: ReturnType<TestKafka['kafka']['admin']>;
const runtimes: ConsumerRuntime[] = [];

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka([])]);
  pool = createPool({
    connectionString: db.urlFor('payments_svc'),
    applicationName: 'consumer-test',
  });
  const inbox = readFileSync(repoPath('migrations/_templates/processed_events.sql'), 'utf8');
  await pool.query(inbox.split('-- Down Migration')[0] ?? '');
  // The side effect under test: one row per handled event (no unique key on purpose).
  await pool.query(
    'CREATE TABLE effects (event_id uuid NOT NULL, key text NOT NULL, n int NOT NULL)',
  );
  producer = createProducer(kafka.kafka);
  await producer.connect();
  admin = kafka.kafka.admin();
  await admin.connect();
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

afterAll(async () => {
  await admin.disconnect();
  await producer.disconnect();
  await pool.end();
  await Promise.all([db.stop(), kafka.stop()]);
});

let topicSeq = 0;
/** A fresh source topic plus its retry and DLQ topics for `group`. */
async function freshTopic(group: string, partitions = 3): Promise<string> {
  const topic = `test.t${++topicSeq}.v1`;
  const day = 86_400_000;
  const specs: TopicSpec[] = [
    { name: topic, partitions, cleanupPolicy: 'delete', retentionMs: day },
    { name: retryTopic(topic, group), partitions, cleanupPolicy: 'delete', retentionMs: day },
    { name: dlqTopic(topic, group), partitions: 3, cleanupPolicy: 'delete', retentionMs: day },
  ];
  await admin.createTopics({
    topics: specs.map((t) => ({
      topic: t.name,
      numPartitions: t.partitions,
      replicationFactor: 1,
    })),
  });
  return topic;
}

function event(key: string, n: number): Envelope<TestPayload> {
  return createEnvelope({
    eventType: 'TestHappened',
    eventVersion: 1,
    producer: 'test',
    correlationId: uuidv7(),
    payload: { key, n },
  });
}

async function publish(topic: string, events: readonly Envelope<TestPayload>[]): Promise<void> {
  await producer.send({
    topic,
    messages: events.map((e) => ({
      key: e.payload.key,
      value: JSON.stringify(e),
      headers: eventHeaders(e),
    })),
  });
}

type Handle = (e: Envelope<TestPayload>, attempt: number) => Promise<void> | void;

function runtime(
  topic: string,
  group: string,
  handle: Handle = () => undefined,
  extra: Partial<ConsumerRuntimeOptions> = {},
): ConsumerRuntime {
  const attempts = new Map<string, number>();
  const r = new ConsumerRuntime({
    kafka: kafka.kafka,
    pool,
    producer,
    group,
    schema: 'payments',
    inProcessDelaysMs: [10, 10],
    retryBaseDelayMs: 200,
    handlers: [
      on(testEvent(topic), async (e, ctx) => {
        const attempt = (attempts.get(e.eventId) ?? 0) + 1;
        attempts.set(e.eventId, attempt);
        await handle(e, attempt);
        await ctx.tx.query('INSERT INTO effects (event_id, key, n) VALUES ($1, $2, $3)', [
          e.eventId,
          e.payload.key,
          e.payload.n,
        ]);
      }),
    ],
    ...extra,
  });
  runtimes.push(r);
  return r;
}

async function effectsFor(ids: readonly string[]): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ event_id: string; n: string }>(
    'SELECT event_id, count(*) AS n FROM effects WHERE event_id = ANY($1::uuid[]) GROUP BY 1',
    [ids],
  );
  return new Map(rows.map((r) => [r.event_id, Number(r.n)]));
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Committed offset == end of log for every partition of `topic`. */
async function fullyCommitted(r: ConsumerRuntime, topic: string): Promise<boolean> {
  // Before the first assignment the group has no coordinator yet ("Not coordinator").
  if (r.assignment().length === 0) return false;
  const ends = await admin.fetchTopicOffsets(topic);
  const committed = await r
    .committed(
      topic,
      ends.map((e) => e.partition),
    )
    .catch(() => null);
  return (
    committed !== null &&
    ends.every((end) => end.high === '0' || committed.get(end.partition) === end.high)
  );
}

describe('ConsumerRuntime', () => {
  it('processes the same event delivered 3 times exactly once (SPEC §4.4, §13.2)', async () => {
    const group = 'g-idempotent';
    const topic = await freshTopic(group);
    const e = event('acc_1', 1);
    await publish(topic, [e, e, e]);

    const registry = createMetricsRegistry('test', false);
    const r = runtime(topic, group, undefined, { registry });
    await r.start();
    await waitFor(() => fullyCommitted(r, topic));

    expect((await effectsFor([e.eventId])).get(e.eventId)).toBe(1);
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/outcome="ok",service="test"\} 1/);
    expect(metrics).toMatch(/outcome="duplicate",service="test"\} 2/);
  });

  it('recovers a transient failure through the retry topic and commits once (SPEC §4.6)', async () => {
    const group = 'g-retry';
    const topic = await freshTopic(group);
    const e = event('acc_2', 2);
    await publish(topic, [e]);

    // Attempts 1-3 (in process) fail, attempt 4 (first retry-topic round) succeeds.
    const r = runtime(topic, group, (_ev, attempt) => {
      if (attempt <= 3) throw new TransientError('database unavailable');
    });
    await r.start();

    await waitFor(async () => (await effectsFor([e.eventId])).get(e.eventId) === 1);
    await waitFor(() => fullyCommitted(r, topic));
    await waitFor(() => fullyCommitted(r, retryTopic(topic, group)));
    const retried = await readAll(kafka.kafka, [retryTopic(topic, group)]);
    expect(retried).toHaveLength(1);
    expect(retried[0]?.headers).toMatchObject({
      'retry-count': '1',
      [DlqHeaders.originalTopic]: topic,
    });
    expect((await effectsFor([e.eventId])).get(e.eventId)).toBe(1);
  });

  it('sends an invalid payload straight to the DLQ and keeps the partition flowing', async () => {
    const group = 'g-dlq';
    const topic = await freshTopic(group, 1);
    const good = event('acc_3', 3);
    await producer.send({
      topic,
      messages: [
        {
          key: 'acc_3',
          value: '{"eventType":"TestHappened","eventVersion":1,"bad":true}',
          headers: { 'event-id': 'x' },
        },
      ],
    });
    await publish(topic, [good]);

    const r = runtime(topic, group);
    await r.start();
    await waitFor(async () => (await effectsFor([good.eventId])).get(good.eventId) === 1);

    const dlq = await readAll(kafka.kafka, [dlqTopic(topic, group)]);
    expect(dlq).toHaveLength(1);
    const headers = dlq[0]?.headers ?? {};
    expect(dlq[0]?.key).toBe('acc_3');
    expect(dlq[0]?.value).toContain('"bad":true');
    expect(headers['event-id']).toBe('x'); // original headers kept
    expect(headers).toMatchObject({
      [DlqHeaders.reason]: 'schema-validation',
      [DlqHeaders.originalTopic]: topic,
      [DlqHeaders.originalPartition]: '0',
      [DlqHeaders.originalOffset]: '0',
    });
    expect(headers[DlqHeaders.errorMessage]).toMatch(/invalid TestHappened/);
    expect(Date.parse(headers[DlqHeaders.failedAt] ?? '')).not.toBeNaN();
    await waitFor(() => fullyCommitted(r, topic));
  });

  it('sends a message to the DLQ after the last retry round', async () => {
    const group = 'g-exhausted';
    const topic = await freshTopic(group, 1);
    const e = event('acc_4', 4);
    await publish(topic, [e]);

    await runtime(
      topic,
      group,
      () => {
        throw new TransientError('still down');
      },
      { maxRetryRounds: 2, retryBaseDelayMs: 50 },
    ).start();

    await waitFor(async () => (await readAll(kafka.kafka, [dlqTopic(topic, group)])).length === 1);
    const [dead] = await readAll(kafka.kafka, [dlqTopic(topic, group)]);
    expect(dead?.headers).toMatchObject({
      [DlqHeaders.reason]: 'retries-exhausted',
      'retry-count': '2',
      [DlqHeaders.originalTopic]: topic,
    });
    expect(await effectsFor([e.eventId])).toEqual(new Map());
  });

  it('assigns partition N of co-partitioned topics to the same instance (range, ADR-002)', async () => {
    const group = 'g-range';
    const a = await freshTopic(group, 12);
    const b = await freshTopic(group, 12);
    const make = () =>
      new ConsumerRuntime({
        kafka: kafka.kafka,
        pool,
        producer,
        group,
        schema: 'payments',
        handlers: [
          on(testEvent(a), () => Promise.resolve()),
          on(testEvent(b), () => Promise.resolve()),
        ],
      });
    const [r1, r2] = [make(), make()];
    runtimes.push(r1, r2);
    await r1.start();
    await r2.start();

    const sourcePartitions = (r: ConsumerRuntime, topic: string) =>
      r
        .assignment()
        .filter((p) => p.topic === topic)
        .map((p) => p.partition)
        .sort((x, y) => x - y);
    await waitFor(() =>
      Promise.resolve(
        sourcePartitions(r1, a).length + sourcePartitions(r2, a).length === 12 &&
          sourcePartitions(r1, a).length > 0 &&
          sourcePartitions(r2, a).length > 0,
      ),
    );
    for (const r of [r1, r2]) {
      expect(sourcePartitions(r, b)).toEqual(sourcePartitions(r, a));
    }
  });

  it('loses nothing and duplicates nothing when one of two consumers stops mid-stream (SPEC §13.2)', async () => {
    const group = 'g-rebalance';
    const topic = await freshTopic(group, 6);
    const events = Array.from({ length: 300 }, (_, i) => event(`acc_${i % 30}`, i));
    const slow = () => new Promise<void>((r) => setTimeout(r, 5));

    const r1 = runtime(topic, group, slow);
    const r2 = runtime(topic, group, slow);
    await r1.start();
    await r2.start();
    await publish(topic, events);

    const ids = events.map((e) => e.eventId);
    await waitFor(async () => [...(await effectsFor(ids)).values()].length >= 60);
    await r2.stop();
    await waitFor(async () => (await effectsFor(ids)).size === 300);
    await waitFor(() => fullyCommitted(r1, topic));

    const counts = await effectsFor(ids);
    expect(counts.size).toBe(300);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it('purges processed_events older than the retention (SPEC §4.4)', async () => {
    const group = 'g-purge';
    const topic = await freshTopic(group);
    await pool.query(
      `INSERT INTO processed_events (consumer_group, event_id, processed_at)
       VALUES ($1, $2, now() - interval '9 days'), ($1, $3, now())`,
      [group, uuidv7(), uuidv7()],
    );
    const r = runtime(topic, group);
    expect(await r.purgeInbox(8 * 86_400_000)).toBe(1);
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM processed_events WHERE consumer_group = $1',
      [group],
    );
    expect(rows[0]?.n).toBe('1');
  });
});
