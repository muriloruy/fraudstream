import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createEnvelope,
  FraudDecisionMade,
  Topics,
  TransactionAuthorizationRequested,
  uuidv7,
} from '@fraudstream/contracts';
import { createProducer, eventHeaders } from '@fraudstream/kafka';
import { createPool, migrate, type Pool } from '@fraudstream/db';
import { startKafka, startPostgres, type TestKafka, type TestPostgres } from '@fraudstream/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config/config.js';
import { validRequest } from './domain/fixtures.js';
import { ApiKeysRepository } from './infrastructure/db/api-keys.repository.js';

let db: TestPostgres;
let kafka: TestKafka;
let pool: Pool;
let fakeVault: Server;
let vaultUrl: string;
let vaultUp = true;
let apiKey: string;
const apps: NestExpressApplication[] = [];

/** Minimal stand-in for card-vault: tokenizes deterministically, can be switched off. */
function startFakeVault(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (!vaultUp) {
        res.writeHead(503).end();
        return;
      }
      const { pan } = JSON.parse(body) as { pan: string };
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          cardToken: `tok_${'A'.repeat(20)}${pan.slice(-4)}`,
          maskedPan: `${pan.slice(0, 6)}******${pan.slice(-4)}`,
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    }),
  );
}

async function startApi(extra: Record<string, string> = {}) {
  const app = await createApp(
    loadConfig({
      DATABASE_URL_PAYMENTS: db.urlFor('payments_svc'),
      KAFKA_BROKERS: kafka.brokers.join(','),
      VAULT_URL: vaultUrl,
      VAULT_SERVICE_TOKEN: 'service-token-0123456789',
      HASH_PEPPER: 'pepper-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ...extra,
    }),
  );
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app.getUrl();
}

beforeAll(async () => {
  [db, kafka] = await Promise.all([startPostgres(), startKafka()]);
  await migrate({
    databaseUrl: db.urlFor('payments_svc'),
    schema: 'payments',
    dir: fileURLToPath(new URL('../../../migrations/payments', import.meta.url)),
  });
  pool = createPool({ connectionString: db.urlFor('payments_svc'), applicationName: 'test' });
  fakeVault = await startFakeVault();
  vaultUrl = `http://127.0.0.1:${(fakeVault.address() as AddressInfo).port}`;
  apiKey = (await new ApiKeysRepository(pool).create('tests')).key;
});

afterAll(async () => {
  for (const app of apps) await app.close();
  fakeVault.close();
  await pool.end();
  await Promise.all([db.stop(), kafka.stop()]);
});

beforeEach(() => {
  vaultUp = true;
});

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'idempotency-key': uuidv7(),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const count = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query<{ n: string }>(sql, params)).rows[0]?.n);

describe('POST /v1/transactions', () => {
  let base: string;
  beforeAll(async () => {
    base = await startApi();
  });

  it('accepts a valid request: 202, PENDING row and outbox event with token only', async () => {
    const res = await post(base, validRequest());
    expect(res.status).toBe(202);
    const body = (await res.json()) as { transactionId: string; status: string };
    expect(body).toMatchObject({
      status: 'PENDING',
      links: { self: `/v1/transactions/${body.transactionId}` },
    });
    expect(res.headers.get('location')).toBe(`/v1/transactions/${body.transactionId}`);

    const { rows } = await pool.query<{ masked_pan: string; card_token: string; amount: string }>(
      'SELECT masked_pan, card_token, amount FROM transactions WHERE transaction_id = $1',
      [body.transactionId],
    );
    expect(rows).toEqual([
      {
        masked_pan: '411111******1111',
        card_token: 'tok_AAAAAAAAAAAAAAAAAAAA1111',
        amount: '1250.90',
      },
    ]);

    const outbox = await pool.query<{
      topic: string;
      message_key: string;
      payload: unknown;
      headers: Record<string, string>;
    }>('SELECT topic, message_key, payload, headers FROM outbox WHERE payload->>$1 = $2', [
      'correlationId',
      body.transactionId,
    ]);
    expect(outbox.rows).toHaveLength(1);
    const event = outbox.rows[0];
    expect(event?.topic).toBe('payments.transactions.v1');
    expect(event?.message_key).toBe('acc_000123');
    expect(TransactionAuthorizationRequested.envelope.safeParse(event?.payload).success).toBe(true);
    expect(event?.headers['event-type']).toBe('TransactionAuthorizationRequested');
    expect(JSON.stringify(event)).not.toContain('4111111111111111');
  });

  it('replays the stored response for the same key and body', async () => {
    const key = uuidv7();
    const first = await post(base, validRequest(), { 'idempotency-key': key });
    const second = await post(base, validRequest(), { 'idempotency-key': key });
    expect(second.status).toBe(202);
    const [a, b] = [await first.json(), await second.json()];
    expect(b).toEqual(a);
    const id = (a as { transactionId: string }).transactionId;
    expect(
      await count('SELECT count(*) AS n FROM transactions WHERE transaction_id = $1', [id]),
    ).toBe(1);
  });

  it('returns 422 when a key is reused with a different body', async () => {
    const key = uuidv7();
    await post(base, validRequest(), { 'idempotency-key': key });
    const other = { ...validRequest(), amount: { value: '99.00', currency: 'BRL' } };
    const res = await post(base, other, { 'idempotency-key': key });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('returns 409 while the same key is still in progress', async () => {
    // Simulate a concurrent first request: same key and body, response not stored yet.
    const key = uuidv7();
    const first = await post(base, validRequest(), { 'idempotency-key': key });
    expect(first.status).toBe(202);
    await pool.query(`UPDATE idempotency_keys SET response_status = 0 WHERE idempotency_key = $1`, [
      key,
    ]);
    const res = await post(base, validRequest(), { 'idempotency-key': key });
    expect(res.status).toBe(409);
  });

  it('requires an Idempotency-Key UUID', async () => {
    const res = await post(base, validRequest(), { 'idempotency-key': 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ field: 'Idempotency-Key' }] });
  });

  it('rejects an invalid PAN with field names only', async () => {
    const body = validRequest();
    body.card.pan = '4111111111111112';
    const res = await post(base, body);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('card.pan');
    expect(text).not.toContain('4111111111111112');
  });

  it('rejects bodies over 16 KB', async () => {
    const body = {
      ...validRequest(),
      merchant: { ...validRequest().merchant, name: 'x'.repeat(17_000) },
    };
    const res = await post(base, body);
    expect(res.status).toBe(413);
  });

  it.each(['', 'fsk_wrong'])('returns 401 for API key %j', async (key) => {
    const before = await count('SELECT count(*) AS n FROM transactions');
    const res = await post(base, validRequest(), { 'x-api-key': key });
    expect(res.status).toBe(401);
    expect(await count('SELECT count(*) AS n FROM transactions')).toBe(before);
  });

  it('returns 503 and persists nothing when the vault is down, then accepts a retry', async () => {
    vaultUp = false;
    const key = uuidv7();
    const before = await count('SELECT count(*) AS n FROM outbox');
    const res = await post(base, validRequest(), { 'idempotency-key': key });
    expect(res.status).toBe(503);
    expect(await count('SELECT count(*) AS n FROM outbox')).toBe(before);
    expect(
      await count('SELECT count(*) AS n FROM idempotency_keys WHERE idempotency_key = $1', [key]),
    ).toBe(0);

    vaultUp = true;
    expect((await post(base, validRequest(), { 'idempotency-key': key })).status).toBe(202);
  });

  it('rolls back the transaction row when the outbox insert fails (atomicity)', async () => {
    await db.container.exec([
      'psql',
      '-U',
      'postgres',
      '-d',
      'fraudstream',
      '-c',
      'ALTER TABLE payments.outbox RENAME TO outbox_off',
    ]);
    try {
      const before = await count('SELECT count(*) AS n FROM transactions');
      const res = await post(base, validRequest());
      expect(res.status).toBe(503);
      expect(await count('SELECT count(*) AS n FROM transactions')).toBe(before);
    } finally {
      await db.container.exec([
        'psql',
        '-U',
        'postgres',
        '-d',
        'fraudstream',
        '-c',
        'ALTER TABLE payments.outbox_off RENAME TO outbox',
      ]);
    }
  });
});

describe('GET /v1/transactions/:id and health', () => {
  let base: string;
  beforeAll(async () => {
    base = await startApi();
  });
  const get = (path: string) => fetch(`${base}${path}`, { headers: { 'x-api-key': apiKey } });

  it('returns the pending transaction', async () => {
    const created = (await (await post(base, validRequest())).json()) as { transactionId: string };
    const res = await get(`/v1/transactions/${created.transactionId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      transactionId: created.transactionId,
      status: 'PENDING',
      maskedPan: '411111******1111',
      amount: { value: '1250.90', currency: 'BRL' },
      finalScore: null,
    });
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    expect((await get(`/v1/transactions/${uuidv7()}`)).status).toBe(404);
    expect((await get('/v1/transactions/abc')).status).toBe(400);
  });

  it('reports liveness and readiness', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({
      status: 'ok',
      checks: { database: 'up', kafka: 'up' },
    });
  });

  it('is not ready when the database is unreachable', async () => {
    const broken = await startApi({
      DATABASE_URL_PAYMENTS: 'postgres://payments_svc:x@127.0.0.1:1/fraudstream',
    });
    expect((await fetch(`${broken}/health/live`)).status).toBe(200);
    const res = await fetch(`${broken}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('database');
  });
});

describe('rate limiting (SPEC §7)', () => {
  it('returns 429 after 100 POSTs per minute for one API key', async () => {
    const base = await startApi({ RATE_LIMIT_PER_MINUTE: '100' });
    const statuses: number[] = [];
    // Guards run before validation, so empty bodies (400) still count against the limit.
    for (let i = 0; i < 101; i++) statuses.push((await post(base, {})).status);
    expect(statuses.slice(0, 100).every((s) => s === 400)).toBe(true);
    expect(statuses[100]).toBe(429);
  });
});

describe('decision status consumer (SPEC §3.3 step 8)', () => {
  it('applies a fraud decision to the transaction once', async () => {
    const base = await startApi();
    const created = (await (await post(base, validRequest())).json()) as { transactionId: string };
    const producer = createProducer(kafka.kafka);
    await producer.connect();
    const decision = (d: 'DECLINE' | 'APPROVE', finalScore: number) =>
      createEnvelope({
        eventType: FraudDecisionMade.eventType,
        eventVersion: 1,
        producer: 'decision-engine',
        correlationId: created.transactionId,
        payload: {
          transactionId: created.transactionId,
          accountId: 'acc_000123',
          decision: d,
          finalScore,
          components: { ruleScore: 1, anomalyScore: 0.5 },
          reasons: ['R006 card_testing'],
          partial: false,
          decidedAt: new Date().toISOString(),
          latencyMs: 120,
        },
      });
    const send = async (e: ReturnType<typeof decision>) =>
      producer.send({
        topic: Topics.decisions,
        messages: [{ key: 'acc_000123', value: JSON.stringify(e), headers: eventHeaders(e) }],
      });

    const decline = decision('DECLINE', 0.8);
    await send(decline);
    const deadline = Date.now() + 60_000;
    let body: { status: string; finalScore: string | null; decidedAt: string | null } | undefined;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/v1/transactions/${created.transactionId}`, {
        headers: { 'x-api-key': apiKey },
      });
      body = (await res.json()) as typeof body;
      if (body?.status !== 'PENDING') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(body).toMatchObject({ status: 'DECLINED', finalScore: '0.8000' });
    expect(body?.decidedAt).not.toBeNull();

    // A redelivery and a conflicting late decision change nothing.
    await send(decline);
    await send(decision('APPROVE', 0.1));
    await new Promise((r) => setTimeout(r, 2000));
    const again = (await (
      await fetch(`${base}/v1/transactions/${created.transactionId}`, {
        headers: { 'x-api-key': apiKey },
      })
    ).json()) as { status: string };
    expect(again.status).toBe('DECLINED');
    await producer.disconnect();
  });
});
