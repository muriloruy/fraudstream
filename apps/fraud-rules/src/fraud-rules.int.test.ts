import { readFileSync } from 'node:fs';
import {
  AccountProfileUpserted,
  createEnvelope,
  FraudRulesEvaluated,
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
import { toFacts } from './application/evaluate-transaction.js';
import { createApp } from './app.js';
import { loadConfig } from './config/config.js';
import { loadRuleset } from './config/ruleset-loader.js';
import { RulesRepository } from './infrastructure/db/rules.repository.js';

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
  requestedAt: Date,
  merchantId = 'mer_771',
): Envelope<TransactionAuthorizationRequestedV1> {
  const transactionId = uuidv7(requestedAt.getTime());
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
      merchant: { ...fixture.payload.merchant, id: merchantId },
      requestedAt: requestedAt.toISOString(),
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

/** Results published by the service for an account, from the outbox (what the relay sends). */
async function resultsFor(accountId: string) {
  const { rows } = await pool.query<{
    payload: {
      payload: {
        transactionId: string;
        ruleScore: number;
        hardDecline: boolean;
        firedRules: { ruleId: string }[];
      };
    };
  }>(`SELECT payload FROM outbox WHERE message_key = $1 ORDER BY id`, [accountId]);
  return rows.map((r) => r.payload.payload);
}

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const url = db.urlFor('fraud_rules_svc');
  await migrate({
    databaseUrl: url,
    schema: 'fraud_rules',
    dir: repoPath('migrations/fraud_rules'),
  });
  pool = createPool({ connectionString: url, applicationName: 'test' });
  producer = createProducer(kafka.kafka);
  await producer.connect();
  app = await createApp(
    loadConfig({
      DATABASE_URL_FRAUD_RULES: url,
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

describe('rule context (SPEC §6.4)', () => {
  it('loads every aggregate in one query', async () => {
    const now = new Date('2026-10-12T15:00:00Z');
    const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
    await pool.query(
      `INSERT INTO account_activity (account_id, transaction_id, amount, merchant_id, country, geo_lat, geo_lon, occurred_at) VALUES
        ('acc_ctx', $1, 2.00, 'mer_a', 'BR', -23.5, -46.6, $2),
        ('acc_ctx', $3, 3.50, 'mer_a', 'BR', -23.5, -46.6, $4),
        ('acc_ctx', $5, 100.00, 'mer_b', 'BR', -23.5, -46.6, $6),
        ('acc_ctx', $7, 400.00, 'mer_c', 'PT', 38.7, -9.1, $8),
        ('acc_ctx', $9, 999.00, 'mer_d', 'BR', null, null, $10)`,
      [
        uuidv7(),
        ago(30),
        uuidv7(),
        ago(120),
        uuidv7(),
        ago(1800),
        uuidv7(),
        ago(10),
        uuidv7(),
        ago(40 * 86400),
      ],
    );
    await pool.query(
      `INSERT INTO account_profiles VALUES ('acc_ctx', 'BR', 'Recife', 'LOW', 8000.00, now())`,
    );
    await pool.query(`INSERT INTO known_merchants VALUES ('acc_ctx', 'mer_b', now())`);

    let queries = 0;
    const counting = {
      query: (text: string, values: unknown[]) => {
        queries++;
        return pool.query(text, values);
      },
    } as unknown as Pool;
    const repo = new RulesRepository(loadRuleset());
    const ctx = await repo.loadContext(counting, {
      ...toFacts(transaction('acc_ctx', '10.00', now, 'mer_b').payload),
      mcc: '7995',
    });

    expect(queries).toBe(1);
    expect(ctx).toMatchObject({
      countInVelocityWindow: 2, // 10 s and 30 s ago
      sumInAmountWindowCents: 50_550n, // last hour: 2.00 + 3.50 + 100.00 + 400.00
      smallInTestingWindow: 2, // 2.00 and 3.50 within 10 min
      historyCount: 4, // the 40-day-old row is outside 30 days
      historySumCents: 50_550n,
      last: { country: 'PT', lat: 38.7, lon: -9.1 },
      knownMerchant: true,
      blocklistHits: ['MCC:7995'],
      profile: { homeCountry: 'BR', creditLimitCents: 800_000n },
    });
  });
});

describe('fraud-rules service', () => {
  it('evaluates a transaction once even if delivered twice, and records it', async () => {
    const e = transaction('acc_dup', '50.00', new Date());
    await publish(Topics.transactions, [e, e]);
    const results = await waitFor(async () => {
      const r = await resultsFor('acc_dup');
      return r.length > 0 ? r : undefined;
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await resultsFor('acc_dup')).toHaveLength(1);
    expect(results[0]).toMatchObject({
      transactionId: e.payload.transactionId,
      ruleScore: 0,
      hardDecline: false,
    });
    const { rows } = await pool.query('SELECT 1 FROM account_activity WHERE transaction_id = $1', [
      e.payload.transactionId,
    ]);
    expect(rows).toHaveLength(1);

    // The relay embedded in the service publishes the result with the causation chain.
    const published = await waitFor(async () => {
      const all = await readAll(kafka.kafka, [Topics.ruleResults]);
      return all.find((m) => m.key === 'acc_dup');
    });
    const envelope = FraudRulesEvaluated.envelope.parse(JSON.parse(published.value ?? ''));
    expect(envelope.causationId).toBe(e.eventId);
    expect(envelope.correlationId).toBe(e.payload.transactionId);
    expect(envelope.payload.requestedAt).toBe(e.payload.requestedAt);
  });

  it('declines a card-testing burst on the 3rd small transaction (R006)', async () => {
    const start = Date.now();
    const burst = [0, 1, 2].map((i) =>
      transaction('acc_testing', '1.99', new Date(start + i * 1000)),
    );
    await publish(Topics.transactions, burst);
    const results = await waitFor(async () => {
      const r = await resultsFor('acc_testing');
      return r.length === 3 ? r : undefined;
    });
    expect(results.map((r) => r.hardDecline)).toEqual([false, false, true]);
    expect(results[2]?.firedRules.map((h) => h.ruleId)).toContain('R006');
  });

  it('materializes profiles and deletes them on a tombstone', async () => {
    const profile = createEnvelope({
      eventType: AccountProfileUpserted.eventType,
      eventVersion: 1,
      producer: 'simulator',
      correlationId: uuidv7(),
      payload: {
        accountId: 'acc_profile',
        homeCountry: 'BR',
        homeCity: 'Recife',
        createdAt: new Date().toISOString(),
        riskTier: 'HIGH' as const,
        creditLimit: '1500.00',
      },
    });
    await publish(Topics.accountProfiles, [profile]);
    await waitFor(async () => {
      const { rows } = await pool.query<{ risk_tier: string; credit_limit: string }>(
        'SELECT risk_tier, credit_limit FROM account_profiles WHERE account_id = $1',
        ['acc_profile'],
      );
      return rows[0];
    });

    await producer.send({
      topic: Topics.accountProfiles,
      messages: [{ key: 'acc_profile', value: null }],
    });
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT 1 FROM account_profiles WHERE account_id = $1', [
        'acc_profile',
      ]);
      return rows.length === 0 ? true : undefined;
    });
  });

  it('cleans up activity older than 30 days', async () => {
    await pool.query(
      `INSERT INTO account_activity (account_id, transaction_id, amount, merchant_id, country, occurred_at)
       VALUES ('acc_old', $1, 1.00, 'm', 'BR', now() - interval '31 days'), ('acc_old', $2, 1.00, 'm', 'BR', now() - interval '29 days')`,
      [uuidv7(), uuidv7()],
    );
    expect(await RulesRepository.cleanupActivity(pool)).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query('SELECT 1 FROM account_activity WHERE account_id = $1', [
      'acc_old',
    ]);
    expect(rows).toHaveLength(1);
  });

  it('serves health and metrics', async () => {
    const base = await app.getUrl();
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('kafka_consumer_messages_total');
    expect(metrics).toContain('outbox_lag_rows');
  });
});
