import { parseBrokers } from '@fraudstream/kafka';
import { isPlaceholderSecret } from '@fraudstream/security';
import { z } from 'zod';

export interface ApiConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  vaultUrl: string;
  vaultServiceToken: string;
  vaultTimeoutMs: number;
  hashPepper: string;
  rateLimitPerMinute: number;
  corsOrigins: string[];
}

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_PAYMENTS: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  VAULT_URL: z.url(),
  VAULT_SERVICE_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  VAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  HASH_PEPPER: z.string().min(16, 'must be at least 16 characters'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
  CORS_ORIGINS: z.string().default(''),
});

/** Validated at startup; refuses placeholder secrets in production (SPEC §14.3). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid transaction-api configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    for (const [name, value] of [
      ['VAULT_SERVICE_TOKEN', e.VAULT_SERVICE_TOKEN],
      ['HASH_PEPPER', e.HASH_PEPPER],
      ['DATABASE_URL_PAYMENTS', e.DATABASE_URL_PAYMENTS],
    ] as const) {
      if (isPlaceholderSecret(value)) throw new Error(`${name} still has a placeholder value`);
    }
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_PAYMENTS,
    kafkaBrokers: parseBrokers(e.KAFKA_BROKERS),
    vaultUrl: e.VAULT_URL.replace(/\/$/, ''),
    vaultServiceToken: e.VAULT_SERVICE_TOKEN,
    vaultTimeoutMs: e.VAULT_TIMEOUT_MS,
    hashPepper: e.HASH_PEPPER,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
