import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, type Pool } from '@fraudstream/db';
import { startPostgres, type TestPostgres } from '@fraudstream/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { VaultService } from './application/vault.service.js';
import { loadConfig, type VaultConfig } from './config/config.js';
import { CardsRepository } from './infrastructure/db/cards.repository.js';

const SERVICE_TOKEN = 'service-token-0123456789';
const ADMIN_TOKEN = 'admin-token-0123456789ab';
const key = () => `base64:${randomBytes(32).toString('base64')}`;
const V1 = key();
const HMAC = key();

let db: TestPostgres;
let pool: Pool;
let app: NestExpressApplication;
let base: string;

function configWith(extra: Record<string, string> = {}): VaultConfig {
  return loadConfig({
    DATABASE_URL_VAULT: db.urlFor('vault_svc'),
    VAULT_DEK_V1: V1,
    VAULT_HMAC_KEY: HMAC,
    VAULT_SERVICE_TOKEN: SERVICE_TOKEN,
    VAULT_ADMIN_TOKEN: ADMIN_TOKEN,
    LOG_LEVEL: 'silent',
    ...extra,
  });
}

beforeAll(async () => {
  db = await startPostgres();
  await migrate({
    databaseUrl: db.urlFor('vault_svc'),
    schema: 'vault',
    dir: fileURLToPath(new URL('../../../migrations/vault', import.meta.url)),
  });
  pool = createPool({ connectionString: db.urlFor('vault_svc'), applicationName: 'test' });
  app = await createApp(configWith());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await db.stop();
});

const call = (path: string, body: unknown, token?: string) =>
  fetch(`${base}/internal/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const card = (pan: string) => ({ pan, expiryMonth: 12, expiryYear: 2029 });

describe('POST /internal/tokenize', () => {
  it('tokenizes a new card and stores only ciphertext', async () => {
    const res = await call('tokenize', card('4111111111111111'), SERVICE_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body).toMatchObject({ maskedPan: '411111******1111', bin: '411111', last4: '1111' });
    expect(body.cardToken).toMatch(/^tok_[0-9A-Za-z]{43}$/);

    const dump = await db.dump();
    expect(dump).not.toContain('4111111111111111');
    expect(dump).not.toMatch(/cvv/i);
  });

  it('returns the same token for the same card, with one row', async () => {
    const pan = '5555555555554444';
    const tokens = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const res = await call('tokenize', card(pan), SERVICE_TOKEN);
        return ((await res.json()) as { cardToken: string }).cardToken;
      }),
    );
    expect(new Set(tokens).size).toBe(1);
    const { rows } = await pool.query("SELECT 1 FROM cards WHERE last4 = '4444'");
    expect(rows).toHaveLength(1);
  });

  it('rejects calls without the service token', async () => {
    expect((await call('tokenize', card('4111111111111111'))).status).toBe(401);
    expect((await call('tokenize', card('4111111111111111'), 'wrong-token')).status).toBe(401);
  });

  it('rejects an invalid PAN without echoing it', async () => {
    const res = await call('tokenize', card('4111111111111112'), SERVICE_TOKEN);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('4111111111111112');
  });
});

describe('POST /internal/detokenize', () => {
  it('is denied for the service token and the attempt is audited', async () => {
    const tokenized = await call('tokenize', card('4012888888881881'), SERVICE_TOKEN);
    const { cardToken } = (await tokenized.json()) as { cardToken: string };

    const res = await call('detokenize', { cardToken }, SERVICE_TOKEN);
    expect(res.status).toBe(403);
    const { rows } = await pool.query<{ actor_role: string; outcome: string }>(
      'SELECT actor_role, outcome FROM audit_log WHERE card_token = $1',
      [cardToken],
    );
    expect(rows).toEqual([{ actor_role: 'service', outcome: 'DENIED' }]);
  });

  it('returns the PAN to vault-admin and audits it', async () => {
    const tokenized = await call('tokenize', card('378282246310005'), SERVICE_TOKEN);
    const { cardToken } = (await tokenized.json()) as { cardToken: string };

    const res = await call('detokenize', { cardToken }, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pan: '378282246310005', expiryMonth: 12, expiryYear: 2029 });
    const { rows } = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM audit_log WHERE card_token = $1',
      [cardToken],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['ALLOWED']);
  });

  it('keeps the audit log append-only for the service role', async () => {
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
  });
});

describe('key rotation (pnpm vault:rotate)', () => {
  it('re-encrypts every card with v2 without changing tokens', async () => {
    const before = await pool.query<{ card_token: string }>(
      'SELECT card_token FROM cards ORDER BY card_token',
    );
    const config = configWith({ VAULT_DEK_V2: key() });
    expect(config.keyring.activeVersion).toBe(2);
    const vault = new VaultService(new CardsRepository(pool), config.keyring, config.hmacKey);

    const rotated = await vault.rotateKeys(pool, 2);
    expect(rotated).toBe(before.rows.length);

    const after = await pool.query<{ card_token: string; key_version: number }>(
      'SELECT card_token, key_version FROM cards ORDER BY card_token',
    );
    expect(after.rows.map((r) => r.card_token)).toEqual(before.rows.map((r) => r.card_token));
    expect(after.rows.every((r) => r.key_version === 2)).toBe(true);

    for (const { card_token } of after.rows) {
      const result = await vault.detokenize(card_token, 'vault-admin');
      expect(result.pan).toMatch(/^\d{13,19}$/);
    }
    expect(await vault.rotateKeys(pool)).toBe(0);
  });
});
