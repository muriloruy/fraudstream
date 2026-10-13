import { createHmac } from 'node:crypto';
import { parseBrokers } from '@fraudstream/kafka';
import { isPlaceholderSecret } from '@fraudstream/security';
import { z } from 'zod';
import { parseDurationMs } from '../domain/duration.js';

export interface GatewayConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  jwtSecret: Buffer;
  /** Separate key derived from the JWT secret for keyset cursors (key separation). */
  cursorKey: Buffer;
  accessTtlMs: number;
  refreshTtlMs: number;
  streamSessionTtlMs: number;
  hashPepper: string;
  corsOrigins: string[];
  loginRateLimitPerMinute: number;
  /** Fraction of decisions pushed to the stream as `decision.made` (SPEC §6.8 "sampled"). */
  decisionSampleRate: number;
  metricsTickMs: number;
  projectionRetentionMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3006),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_ALERTS: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  STREAM_SESSION_TTL: z.string().default('15m'),
  HASH_PEPPER: z.string().min(16, 'must be at least 16 characters'),
  // The dashboard (Vite dev server) by default; never "*" because the API uses cookies.
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  STREAM_DECISION_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  STREAM_METRICS_TICK_MS: z.coerce.number().int().positive().default(2000),
  ALERTS_PROJECTION_RETENTION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * DAY_MS),
});

/** Validated at startup; refuses placeholder secrets in production (SPEC §14.3). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid alerts-gateway configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    for (const [name, value] of [
      ['JWT_ACCESS_SECRET', e.JWT_ACCESS_SECRET],
      ['HASH_PEPPER', e.HASH_PEPPER],
      ['DATABASE_URL_ALERTS', e.DATABASE_URL_ALERTS],
    ] as const) {
      if (isPlaceholderSecret(value)) throw new Error(`${name} still has a placeholder value`);
    }
  }
  const corsOrigins = e.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins.includes('*')) throw new Error('CORS_ORIGINS must list origins, not "*"');
  const jwtSecret = Buffer.from(e.JWT_ACCESS_SECRET);
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_ALERTS,
    kafkaBrokers: parseBrokers(e.KAFKA_BROKERS),
    jwtSecret,
    cursorKey: createHmac('sha256', jwtSecret).update('alerts-gateway/keyset-cursor/v1').digest(),
    accessTtlMs: parseDurationMs(e.JWT_ACCESS_TTL),
    refreshTtlMs: parseDurationMs(e.JWT_REFRESH_TTL),
    streamSessionTtlMs: parseDurationMs(e.STREAM_SESSION_TTL),
    hashPepper: e.HASH_PEPPER,
    corsOrigins,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
    decisionSampleRate: e.STREAM_DECISION_SAMPLE_RATE,
    metricsTickMs: e.STREAM_METRICS_TICK_MS,
    projectionRetentionMs: e.ALERTS_PROJECTION_RETENTION_MS,
  };
}
