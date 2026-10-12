import { decodeBase64Key, isPlaceholderSecret } from '@fraudstream/security';
import { z } from 'zod';
import { Keyring } from '../domain/crypto.js';

export interface VaultConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  keyring: Keyring;
  hmacKey: Buffer;
  serviceToken: string;
  adminToken: string;
}

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_VAULT: z.string().min(1),
  VAULT_ACTIVE_KEY_VERSION: z.coerce.number().int().positive().optional(),
  VAULT_HMAC_KEY: z.string().min(1),
  VAULT_SERVICE_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  VAULT_ADMIN_TOKEN: z.string().min(16, 'must be at least 16 characters'),
});

/**
 * Loads and validates configuration at startup (SPEC §14.3). Keys come from env, simulating
 * a KMS: every `VAULT_DEK_V<n>` is a key version, the highest one (or
 * `VAULT_ACTIVE_KEY_VERSION`) encrypts new cards.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): VaultConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid card-vault configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;

  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    const version = /^VAULT_DEK_V(\d+)$/.exec(name)?.[1];
    if (version && value) keys.set(Number(version), decodeBase64Key(name, value, 32));
  }
  if (keys.size === 0) throw new Error('at least one VAULT_DEK_V<n> key is required');
  const activeVersion = e.VAULT_ACTIVE_KEY_VERSION ?? Math.max(...keys.keys());

  if (e.NODE_ENV === 'production') {
    for (const [name, value] of [
      ['VAULT_SERVICE_TOKEN', e.VAULT_SERVICE_TOKEN],
      ['VAULT_ADMIN_TOKEN', e.VAULT_ADMIN_TOKEN],
      ['DATABASE_URL_VAULT', e.DATABASE_URL_VAULT],
    ] as const) {
      if (isPlaceholderSecret(value)) throw new Error(`${name} still has a placeholder value`);
    }
  }
  if (e.VAULT_SERVICE_TOKEN === e.VAULT_ADMIN_TOKEN) {
    throw new Error('VAULT_SERVICE_TOKEN and VAULT_ADMIN_TOKEN must differ');
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_VAULT,
    keyring: new Keyring(keys, activeVersion),
    hmacKey: decodeBase64Key('VAULT_HMAC_KEY', e.VAULT_HMAC_KEY, 32),
    serviceToken: e.VAULT_SERVICE_TOKEN,
    adminToken: e.VAULT_ADMIN_TOKEN,
  };
}
