import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Topics, TransactionAuthorizationRequested } from '@fraudstream/contracts';
import { createPool, type Pool } from '@fraudstream/db';
import { createKafka, createProducer, type Producer } from '@fraudstream/kafka';
import {
  readAll,
  repoPath,
  REPO_ROOT,
  startKafka,
  startPostgres,
  type TestKafka,
  type TestPostgres,
} from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed, SEED_PRODUCER, type SeedResult } from './application/seed.js';
import { buildWorld } from './domain/world.js';

const ACCOUNTS = 100;

let db: TestPostgres;
let kafka: TestKafka;
let producer: Producer;
let rules: Pool;
let anomaly: Pool;
let result: SeedResult;
const services: ChildProcess[] = [];
const pans = new Map(buildWorld(42, ACCOUNTS).accounts.map((a) => [a.accountId, a.card.pan]));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

/** Runs a service's build (`dist/main.js`) as its own process, like the container does. */
function spawnService(name: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [repoPath(`apps/${name}/dist/main.js`)], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'development',
      MIGRATE_ON_START: 'true',
      ...env,
    },
    stdio: 'ignore',
  });
  services.push(child);
  return child;
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function count(pool: Pool, sql: string): Promise<number> {
  try {
    const { rows } = await pool.query<{ n: number }>(sql);
    return rows[0]?.n ?? 0;
  } catch {
    return 0; // tables appear once the service has migrated its schema
  }
}

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  const brokers = kafka.brokers.join(',');
  spawnService('fraud-rules', {
    PORT: String(await freePort()),
    DATABASE_URL_FRAUD_RULES: db.urlFor('fraud_rules_svc'),
    KAFKA_BROKERS: brokers,
  });
  spawnService('anomaly-scorer', {
    PORT: String(await freePort()),
    DATABASE_URL_ANOMALY: db.urlFor('anomaly_svc'),
    KAFKA_BROKERS: brokers,
  });
  rules = createPool({
    connectionString: db.urlFor('fraud_rules_svc'),
    applicationName: 'seed-test',
  });
  anomaly = createPool({
    connectionString: db.urlFor('anomaly_svc'),
    applicationName: 'seed-test',
  });

  producer = createProducer(createKafka({ brokers: kafka.brokers, clientId: 'seed-test' }));
  await producer.connect();
  result = await seed(producer, { accounts: ACCOUNTS, seed: 42, days: 30, hashPepper: 'pepper' });
});

afterAll(async () => {
  for (const child of services) child.kill('SIGTERM');
  await producer.disconnect();
  await Promise.all([rules.end(), anomaly.end()]);
  await Promise.all([kafka.stop(), db.stop()]);
});

describe('sim:seed (SPEC §6.9)', () => {
  it('publishes one profile per account and valid, time-ordered history per account', async () => {
    expect(result.profiles).toBe(ACCOUNTS);
    expect(result.transactions).toBeGreaterThan(ACCOUNTS * 14);

    const profiles = await readAll(kafka.kafka, [Topics.accountProfiles]);
    expect(new Set(profiles.map((m) => m.key)).size).toBe(ACCOUNTS);

    const history = await readAll(kafka.kafka, [Topics.transactions]);
    expect(history).toHaveLength(result.transactions);
    const byAccount = new Map<string, number[]>();
    for (const message of history) {
      const envelope = TransactionAuthorizationRequested.envelope.parse(
        JSON.parse(message.value ?? 'null'),
      );
      expect(envelope.producer).toBe(SEED_PRODUCER);
      expect(message.key).toBe(envelope.payload.accountId);
      // Backfill is not traced: the trace context says not sampled.
      expect(message.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
      // A PAN never goes to Kafka: only the masked form of the card.
      expect(message.value).not.toContain(pans.get(envelope.payload.accountId));
      const times = byAccount.get(envelope.payload.accountId) ?? [];
      times.push(Date.parse(envelope.payload.requestedAt));
      byAccount.set(envelope.payload.accountId, times);
    }
    // Keyed by account: one partition, so the consumers see each account's history in order.
    for (const times of byAccount.values()) expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('materializes the profiles in fraud-rules and builds the anomaly baselines', async () => {
    await waitFor(
      async () =>
        (await count(rules, 'SELECT count(*)::int AS n FROM account_profiles')) === ACCOUNTS,
    );
    await waitFor(
      async () =>
        (await count(rules, 'SELECT count(*)::int AS n FROM account_activity')) ===
        result.transactions,
    );
    await waitFor(
      async () =>
        (await count(anomaly, 'SELECT coalesce(sum(n), 0)::int AS n FROM account_baselines')) ===
        result.transactions,
    );
    // Out of cold start (n >= 10, SPEC §6.5) for nearly every account.
    const warm = await count(
      anomaly,
      'SELECT count(*)::int AS n FROM account_baselines WHERE n >= 10',
    );
    expect(warm).toBeGreaterThanOrEqual(ACCOUNTS * 0.95);
  });
});
