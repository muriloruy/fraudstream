import { readFileSync } from 'node:fs';
import {
  AnomalyScored,
  createEnvelope,
  FraudDecisionMade,
  FraudRulesEvaluated,
  Topics,
  uuidv7,
  type AnomalyScoredV1,
  type Envelope,
  type FraudRulesEvaluatedV1,
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
import { createApp } from './app.js';
import { loadConfig } from './config/config.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
let producer: Producer;
let app: Awaited<ReturnType<typeof createApp>>;

const fixture = <P>(name: string) =>
  JSON.parse(readFileSync(repoPath(`libs/contracts/fixtures/${name}.json`), 'utf8')) as Envelope<P>;
const rulesFixture = fixture<FraudRulesEvaluatedV1>('fraud-rules-evaluated');
const scoreFixture = fixture<AnomalyScoredV1>('anomaly-scored');

function parts(
  accountId: string,
  ruleScore: number,
  anomalyScore: number,
  baselineSampleSize = 50,
) {
  const transactionId = uuidv7();
  const requestedAt = new Date(Date.now() - 100).toISOString();
  const rules = createEnvelope({
    eventType: FraudRulesEvaluated.eventType,
    eventVersion: 1,
    producer: 'fraud-rules',
    correlationId: transactionId,
    payload: {
      ...rulesFixture.payload,
      transactionId,
      accountId,
      ruleScore,
      hardDecline: false,
      firedRules: [],
      requestedAt,
    },
  });
  const score = createEnvelope({
    eventType: AnomalyScored.eventType,
    eventVersion: 1,
    producer: 'anomaly-scorer',
    correlationId: transactionId,
    payload: {
      ...scoreFixture.payload,
      transactionId,
      accountId,
      anomalyScore,
      baselineSampleSize,
      requestedAt,
    },
  });
  return { transactionId, rules, score };
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

const decisionsFor = async (transactionId: string) =>
  (
    await pool.query<{
      decision: string;
      final_score: string;
      partial: boolean;
      reasons: string[];
      config_version: string;
    }>(
      'SELECT decision, final_score, partial, reasons, config_version FROM decisions WHERE transaction_id = $1',
      [transactionId],
    )
  ).rows;
const outboxFor = async (transactionId: string) =>
  (await pool.query("SELECT 1 FROM outbox WHERE payload->>'correlationId' = $1", [transactionId]))
    .rowCount;
const decided = (transactionId: string) =>
  waitFor(async () => {
    const rows = await decisionsFor(transactionId);
    return rows[0];
  });

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const url = db.urlFor('decision_svc');
  await migrate({ databaseUrl: url, schema: 'decision', dir: repoPath('migrations/decision') });
  pool = createPool({ connectionString: url, applicationName: 'test' });
  producer = createProducer(kafka.kafka);
  await producer.connect();
  app = await createApp(
    loadConfig({
      DATABASE_URL_DECISION: url,
      KAFKA_BROKERS: kafka.brokers.join(','),
      LOG_LEVEL: 'silent',
      DECISION_JOIN_TIMEOUT_MS: '1500',
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

describe('decision-engine join (SPEC §6.6)', () => {
  it('decides once both parts arrive, rules first', async () => {
    const p = parts('acc_a', 0.62, 0.81);
    await publish(Topics.ruleResults, [p.rules]);
    await publish(Topics.scores, [p.score]);
    const d = await decided(p.transactionId);
    expect(d).toMatchObject({ decision: 'REVIEW', final_score: '0.6960', partial: false }); // 0.6*0.62 + 0.4*0.81
    expect(d.config_version).toMatch(/^fusion-/);
  });

  it('decides once both parts arrive, score first, and publishes the event', async () => {
    const p = parts('acc_b', 0.1, 0.2);
    await publish(Topics.scores, [p.score]);
    await publish(Topics.ruleResults, [p.rules]);
    expect(await decided(p.transactionId)).toMatchObject({ decision: 'APPROVE', partial: false });

    const message = await waitFor(async () =>
      (await readAll(kafka.kafka, [Topics.decisions])).find((m) =>
        m.value?.includes(p.transactionId),
      ),
    );
    const event = FraudDecisionMade.envelope.parse(JSON.parse(message.value ?? ''));
    expect(event.correlationId).toBe(p.transactionId);
    expect(event.causationId).toBe(p.rules.eventId); // caused by the part that completed the join
    expect(event.payload.latencyMs).toBeGreaterThan(0);
    expect(event.payload.breakdown).toMatchObject({
      weights: { rules: 0.6, anomaly: 0.4 },
      thresholds: { approveBelow: 0.4, declineFrom: 0.75 },
      configVersion: expect.stringMatching(/^fusion-/) as unknown,
    });
  });

  it('ignores a duplicate part: one decision, one event', async () => {
    const p = parts('acc_c', 0.9, 0.9);
    await publish(Topics.ruleResults, [p.rules, p.rules]);
    await publish(Topics.scores, [p.score, p.score]);
    expect(await decided(p.transactionId)).toMatchObject({ decision: 'DECLINE' });
    await new Promise((r) => setTimeout(r, 2500));
    expect(await decisionsFor(p.transactionId)).toHaveLength(1);
    expect(await outboxFor(p.transactionId)).toBe(1);
  });

  it('decides partially on the rules after the timeout and ignores the late score', async () => {
    const p = parts('acc_d', 0.3, 0.99);
    await publish(Topics.ruleResults, [p.rules]);
    const d = await decided(p.transactionId);
    expect(d).toMatchObject({ decision: 'APPROVE', final_score: '0.3000', partial: true });
    expect(d.reasons).toContain('anomaly score unavailable (timeout)');

    await publish(Topics.scores, [p.score]);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await decisionsFor(p.transactionId)).toHaveLength(1);
    expect(await outboxFor(p.transactionId)).toBe(1);
    const { rows } = await pool.query('SELECT 1 FROM pending WHERE transaction_id = $1', [
      p.transactionId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('reviews when only the anomaly score arrives', async () => {
    const p = parts('acc_e', 0, 0.05);
    await publish(Topics.scores, [p.score]);
    expect(await decided(p.transactionId)).toMatchObject({ decision: 'REVIEW', partial: true });
  });

  it('exports decision metrics', async () => {
    const metrics = await (await fetch(`${await app.getUrl()}/metrics`)).text();
    expect(metrics).toMatch(/decisions_total\{decision="REVIEW",service="decision-engine"\} [2-9]/);
    expect(metrics).toContain('decision_latency_seconds_bucket');
  });
});
