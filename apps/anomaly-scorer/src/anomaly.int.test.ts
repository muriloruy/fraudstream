import { readFileSync } from 'node:fs';
import {
  AnalystFeedbackRecorded,
  AnomalyScored,
  createEnvelope,
  Topics,
  TransactionAuthorizationRequested,
  uuidv7,
  type Envelope,
  type TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import { createPool, migrate, type Pool } from '@fraudstream/db';
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
import { toObservation } from './application/handlers.js';
import { createApp } from './app.js';
import { loadConfig } from './config/config.js';
import { update, type Baseline } from './domain/scoring.js';
import { AnomalyRepository } from './infrastructure/db/anomaly.repository.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
let producer: Producer;
let app: Awaited<ReturnType<typeof createApp>>;

const fixture = JSON.parse(
  readFileSync(
    repoPath('libs/contracts/fixtures/transaction-authorization-requested.json'),
    'utf8',
  ),
) as Envelope<TransactionAuthorizationRequestedV1>;

function transaction(
  accountId: string,
  amount: string,
  at: Date,
): Envelope<TransactionAuthorizationRequestedV1> {
  const transactionId = uuidv7(at.getTime());
  return createEnvelope({
    eventType: TransactionAuthorizationRequested.eventType,
    eventVersion: 1,
    producer: 'transaction-api',
    correlationId: transactionId,
    payload: {
      ...fixture.payload,
      transactionId,
      accountId,
      amount: { value: amount, currency: 'BRL' },
      requestedAt: at.toISOString(),
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
    await new Promise((r) => setTimeout(r, 200));
  }
}

const baselineOf = async (accountId: string) => {
  const client = await pool.connect();
  try {
    return await new AnomalyRepository().lockBaseline(client, accountId);
  } finally {
    client.release();
  }
};

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const url = db.urlFor('anomaly_svc');
  await migrate({ databaseUrl: url, schema: 'anomaly', dir: repoPath('migrations/anomaly') });
  pool = createPool({ connectionString: url, applicationName: 'test' });
  producer = createProducer(kafka.kafka);
  await producer.connect();
  app = await createApp(
    loadConfig({
      DATABASE_URL_ANOMALY: url,
      KAFKA_BROKERS: kafka.brokers.join(','),
      LOG_LEVEL: 'silent',
    }),
  );
  await app.listen(0, '127.0.0.1');
});

afterAll(async () => {
  await app.close();
  await producer.disconnect();
  await pool.end();
  await Promise.all([db.stop(), kafka.stop()]);
});

describe('anomaly-scorer', () => {
  it('scores a duplicate delivery once: sample size grows by one', async () => {
    const e = transaction('acc_dup', '120.00', new Date());
    await publish(Topics.transactions, [e, e]);
    const published = await waitFor(async () => {
      const all = await readAll(kafka.kafka, [Topics.scores]);
      return all.find((m) => m.key === 'acc_dup');
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await baselineOf('acc_dup'))?.n).toBe(1);
    const scored = AnomalyScored.envelope.parse(JSON.parse(published.value ?? ''));
    expect(scored.payload).toMatchObject({
      transactionId: e.payload.transactionId,
      baselineSampleSize: 0,
      modelVersion: 'ewma-1.0',
    });
    expect(scored.causationId).toBe(e.eventId);
    const { rows } = await pool.query('SELECT 1 FROM outbox WHERE message_key = $1', ['acc_dup']);
    expect(rows).toHaveLength(1);
  });

  it('removes a confirmed-fraud transaction from the baseline exactly', async () => {
    const start = Date.parse('2026-10-01T12:00:00Z');
    const amounts = ['100.00', '110.00', '95.00', '4800.00', '105.00', '120.00'];
    const events = amounts.map((a, i) => transaction('acc_fb', a, new Date(start + i * 3_600_000)));
    await publish(Topics.transactions, events);
    await waitFor(async () => ((await baselineOf('acc_fb'))?.n === 6 ? true : undefined));

    const fraud = events[3];
    if (!fraud) throw new Error('missing event');
    await publish(Topics.analystFeedback, [
      createEnvelope({
        eventType: AnalystFeedbackRecorded.eventType,
        eventVersion: 1,
        producer: 'alerts-gateway',
        correlationId: fraud.payload.transactionId,
        payload: {
          transactionId: fraud.payload.transactionId,
          accountId: 'acc_fb',
          alertId: uuidv7(),
          verdict: 'CONFIRMED_FRAUD' as const,
          analystId: 'usr_1',
          note: 'customer confirmed card stolen',
          recordedAt: new Date().toISOString(),
        },
      }),
    ]);
    const after = await waitFor(async () => {
      const b = await baselineOf('acc_fb');
      return b?.n === 5 ? b : undefined;
    });

    let expected: Baseline | null = null;
    for (const e of events.filter((x) => x !== fraud)) {
      expected = update(expected, 'MEDIUM', toObservation(e.payload, false), 0.1);
    }
    expect(after.amount.mean).toBeCloseTo(expected?.amount.mean ?? NaN, 9);
    expect(after.amount.variance).toBeCloseTo(expected?.amount.variance ?? NaN, 9);
    expect(after.interArrival.mean).toBeCloseTo(expected?.interArrival.mean ?? NaN, 9);
    expect(after.hourHistogram).toEqual(expected?.hourHistogram);
  });
});
