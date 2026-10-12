import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
// The path is a constant derived from this module's location, not user input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

/** Registers a throwaway API key directly in payments.api_keys (only its hash is stored). */
export async function createApiKey(): Promise<string> {
  const url = process.env.DATABASE_URL_PAYMENTS;
  if (!url) throw new Error('DATABASE_URL_PAYMENTS is not set (run pnpm env:init)');
  const key = `fsk_${randomBytes(32).toString('base64url')}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO api_keys (key_id, name, key_hash) VALUES (gen_random_uuid(), 'e2e', $1)`,
      [createHash('sha256').update(key).digest('hex')],
    );
  } finally {
    await client.end();
  }
  return key;
}

export interface Authorization {
  transactionId: string;
  postedAt: number;
}

export function authorizationBody(accountId: string, amount: string) {
  return {
    accountId,
    card: { pan: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123' },
    amount: { value: amount, currency: 'BRL' },
    merchant: { id: 'mer_e2e', name: 'E2E Store', mcc: '5732', country: 'BR', city: 'São Paulo' },
    channel: 'ECOMMERCE',
    entryMode: 'CARD_NOT_PRESENT',
    device: { ip: '203.0.113.10', deviceId: 'e2e-device' },
    geo: { lat: -23.55, lon: -46.63 },
  };
}

export async function authorize(apiKey: string, body: unknown): Promise<Authorization> {
  const postedAt = Date.now();
  const res = await fetch(`${API_URL}/v1/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 202) throw new Error(`POST returned ${res.status}: ${await res.text()}`);
  const { transactionId } = (await res.json()) as { transactionId: string };
  return { transactionId, postedAt };
}

export interface TransactionView {
  status: 'PENDING' | 'APPROVED' | 'REVIEW' | 'DECLINED';
  finalScore: string | null;
}

/** Polls GET /v1/transactions/:id until the decision is reflected; returns it and when. */
export async function waitForDecision(
  apiKey: string,
  transactionId: string,
  timeoutMs = 10_000,
): Promise<TransactionView & { decidedSeenAt: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${API_URL}/v1/transactions/${transactionId}`, {
      headers: { 'x-api-key': apiKey },
    });
    const view = (await res.json()) as TransactionView;
    if (view.status !== 'PENDING') return { ...view, decidedSeenAt: Date.now() };
    if (Date.now() > deadline)
      throw new Error(`no decision for ${transactionId} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
