import { uuidv7 } from '@fraudstream/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './harness.js';

const PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE payments.transactions;--",
  '" OR 1=1 --',
  '1; SELECT pg_sleep(5)--',
  "x' UNION SELECT card_token FROM vault.cards--",
];

let stack: Stack;

const base = () => ({
  accountId: 'acc_sqli',
  card: { pan: '4111111111111111', expiryMonth: 1, expiryYear: 2031, cvv: '321' },
  amount: { value: '15.00', currency: 'BRL' },
  merchant: { id: 'mer_sqli', name: 'Store', mcc: '5411', country: 'BR', city: 'Recife' },
  channel: 'ECOMMERCE',
  entryMode: 'CARD_NOT_PRESENT',
  device: { ip: '192.0.2.1', deviceId: 'dev-1' },
});

type Body = ReturnType<typeof base>;

async function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${stack.apiUrl}/v1/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': stack.apiKey,
      'idempotency-key': uuidv7(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Tables and row counts across the service schemas: what "DB untouched" means here. */
async function snapshot(): Promise<string> {
  const result = await stack.db.container.exec([
    'psql',
    '-U',
    'postgres',
    '-d',
    'fraudstream',
    '-At',
    '-c',
    `SELECT string_agg(table_schema || '.' || table_name, ',' ORDER BY 1)
       FROM information_schema.tables WHERE table_schema IN ('payments', 'vault')`,
  ]);
  return result.stdout.trim();
}

const transactionCount = async () =>
  Number(
    (await stack.payments.query<{ n: string }>('SELECT count(*) AS n FROM transactions')).rows[0]
      ?.n,
  );

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack.stop();
});

/** Fields with a known format are allow-listed, so injection payloads are rejected outright. */
const STRICT_FIELDS: [string, (b: Body, v: string) => void][] = [
  ['accountId', (b, v) => (b.accountId = v)],
  ['merchant.id', (b, v) => (b.merchant.id = v)],
  ['merchant.mcc', (b, v) => (b.merchant.mcc = v)],
  ['merchant.country', (b, v) => (b.merchant.country = v)],
  ['amount.value', (b, v) => (b.amount.value = v)],
  ['amount.currency', (b, v) => (b.amount.currency = v)],
  ['channel', (b, v) => (b.channel = v)],
  ['entryMode', (b, v) => (b.entryMode = v)],
  ['card.pan', (b, v) => (b.card.pan = v)],
  ['card.cvv', (b, v) => (b.card.cvv = v)],
  ['device.ip', (b, v) => (b.device.ip = v)],
];

describe('SQL injection payloads (SPEC §13.5)', () => {
  it.each(STRICT_FIELDS)(
    '%s: every payload returns 400 and changes nothing',
    async (field, set) => {
      const before = [await snapshot(), await transactionCount()];
      for (const payload of PAYLOADS) {
        const body = base();
        set(body, payload);
        const res = await post(body);
        expect(res.status, `${field} = ${payload}`).toBe(400);
        expect(await res.text()).not.toContain(payload);
      }
      expect([await snapshot(), await transactionCount()]).toEqual(before);
    },
  );

  it('free-text fields (merchant name/city, device id) are stored verbatim through bound parameters', async () => {
    const tables = await snapshot();
    for (const payload of PAYLOADS) {
      const body = base();
      body.merchant.name = payload;
      body.merchant.city = payload;
      body.device.deviceId = payload;
      const res = await post(body);
      expect(res.status).toBe(202);
      const { transactionId } = (await res.json()) as { transactionId: string };
      const { rows } = await stack.payments.query<{ name: string; city: string }>(
        `SELECT payload->'payload'->'merchant'->>'name' AS name,
                payload->'payload'->'merchant'->>'city' AS city
           FROM outbox WHERE payload->>'correlationId' = $1`,
        [transactionId],
      );
      // Stored as data, byte for byte; nothing was executed.
      expect(rows).toEqual([{ name: payload, city: payload }]);
    }
    expect(await snapshot()).toBe(tables);
  });

  it('headers and path parameters reject payloads too', async () => {
    for (const payload of PAYLOADS) {
      expect((await post(base(), { 'idempotency-key': payload })).status).toBe(400);
      expect((await post(base(), { 'x-api-key': payload })).status).toBe(401);
      const get = await fetch(`${stack.apiUrl}/v1/transactions/${encodeURIComponent(payload)}`, {
        headers: { 'x-api-key': stack.apiKey },
      });
      expect(get.status).toBe(400);
    }
  });
});
