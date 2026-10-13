import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (pnpm env:init, pnpm users:seed)`);
  return value;
}

/** A throwaway transaction-api key (only its hash is stored). */
export async function createApiKey(): Promise<string> {
  const key = `fsk_${randomBytes(32).toString('base64url')}`;
  const client = new pg.Client({ connectionString: env('DATABASE_URL_PAYMENTS') });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO api_keys (key_id, name, key_hash) VALUES (gen_random_uuid(), 'web-e2e', $1)`,
      [createHash('sha256').update(key).digest('hex')],
    );
  } finally {
    await client.end();
  }
  return key;
}

/** Authorizes a card payment through the public API; the pipeline decides asynchronously. */
export async function authorize(
  apiKey: string,
  accountId: string,
  amount: string,
): Promise<string> {
  const res = await fetch(`${API_URL}/v1/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      accountId,
      card: { pan: '4111111111111111', expiryMonth: 12, expiryYear: 2030, cvv: '123' },
      amount: { value: amount, currency: 'BRL' },
      merchant: {
        id: 'mer_web_e2e',
        name: 'Web E2E Store',
        mcc: '5732',
        country: 'BR',
        city: 'São Paulo',
      },
      channel: 'ECOMMERCE',
      entryMode: 'CARD_NOT_PRESENT',
      device: { ip: '203.0.113.20', deviceId: 'web-e2e-device' },
      geo: { lat: -23.55, lon: -46.63 },
    }),
  });
  if (res.status !== 202) throw new Error(`authorization failed: ${String(res.status)}`);
  return ((await res.json()) as { transactionId: string }).transactionId;
}
