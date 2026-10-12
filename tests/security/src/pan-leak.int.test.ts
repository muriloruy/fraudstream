import { allTopics, uuidv7 } from '@fraudstream/contracts';
import { readAll } from '@fraudstream/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLeaks, startStack, type Stack } from './harness.js';

/** Test PAN (Luhn-valid Visa test number) and a CVV unlikely to occur by chance. */
const PAN = '4000056655665556';
const CVV = '7391';

let stack: Stack;
const responses: string[] = [];

const request = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'acc_leak_test',
  card: { pan: PAN, expiryMonth: 11, expiryYear: 2030, cvv: CVV },
  amount: { value: '42.00', currency: 'BRL' },
  merchant: { id: 'mer_1', name: 'Leak Test Store', mcc: '5411', country: 'BR' },
  channel: 'POS',
  entryMode: 'CHIP',
  device: { ip: '198.51.100.7', deviceId: 'device-leak' },
  ...overrides,
});

async function post(body: unknown): Promise<number> {
  const res = await fetch(`${stack.apiUrl}/v1/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': stack.apiKey,
      'idempotency-key': uuidv7(),
    },
    body: JSON.stringify(body),
  });
  responses.push(
    `${res.status} ${JSON.stringify(Object.fromEntries(res.headers))} ${await res.text()}`,
  );
  return res.status;
}

beforeAll(async () => {
  stack = await startStack();
  // Happy path, a replay-free retry, and failure paths that might echo input.
  expect(await post(request())).toBe(202);
  expect(await post(request())).toBe(202);
  expect(await post(request({ amount: { value: '10.123', currency: 'BRL' } }))).toBe(400);
  expect(await post(request({ channel: 'TELEPATHY' }))).toBe(400);
  expect(await post({ ...request(), unexpected: PAN })).toBe(400);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const { rows } = await stack.payments.query<{ n: string }>(
      'SELECT count(*) AS n FROM outbox WHERE published_at IS NULL',
    );
    if (rows[0]?.n === '0') break;
    if (Date.now() > deadline) throw new Error('relay did not publish in time');
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(async () => {
  await stack.stop();
});

describe('PAN and CVV never leave the vault (SPEC §7)', () => {
  it('the detector itself finds a planted leak (self-check)', () => {
    expect(findLeaks(`{"card":{"pan":"${PAN}","cvv":"${CVV}"}}`, PAN)).toHaveLength(1);
    expect(findLeaks(`{"cvv":"${CVV}"}`, CVV)).toHaveLength(1);
    expect(findLeaks(`01a131c4-${CVV}-7a1d`, CVV)).toHaveLength(0);
  });

  it('logs were captured at trace level and contain neither', () => {
    const logs = stack.logs();
    // The capture really saw every service, including request logs.
    for (const service of ['card-vault', 'transaction-api', 'outbox-relay']) {
      expect(logs).toContain(`"service":"${service}"`);
    }
    expect(logs).toContain('/v1/transactions');
    expect(findLeaks(logs, PAN)).toEqual([]);
    expect(findLeaks(logs, CVV)).toEqual([]);
  });

  it('no Kafka topic contains them', async () => {
    const messages = await readAll(
      stack.kafka.kafka,
      allTopics().map((t) => t.name),
    );
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const all = JSON.stringify(messages);
    expect(findLeaks(all, PAN)).toEqual([]);
    expect(findLeaks(all, CVV)).toEqual([]);
  });

  it('no table outside the vault schema contains them', async () => {
    const dump = await stack.db.dump(['vault']);
    expect(dump).toContain('payments.transactions'); // the dump covers the payments schema
    expect(findLeaks(dump, PAN)).toEqual([]);
    expect(findLeaks(dump, CVV)).toEqual([]);
  });

  it('the vault itself stores no plaintext PAN and no CVV', async () => {
    const dump = await stack.db.dump();
    expect(findLeaks(dump, PAN)).toEqual([]);
    expect(findLeaks(dump, CVV)).toEqual([]);
  });

  it('no API response contains them', () => {
    const all = responses.join('\n');
    expect(findLeaks(all, PAN)).toEqual([]);
    expect(findLeaks(all, CVV)).toEqual([]);
  });
});
