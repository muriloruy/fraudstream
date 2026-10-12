import { parseBrokers } from '@fraudstream/kafka';
import { z } from 'zod';

export interface LedgerConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  /** Projection rows older than this are purged (topic retention 7 days + 1 day). */
  projectionRetentionMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3005),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_LEDGER: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  LEDGER_PROJECTION_RETENTION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * DAY_MS),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LedgerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`invalid ledger configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_LEDGER,
    kafkaBrokers: parseBrokers(e.KAFKA_BROKERS),
    projectionRetentionMs: e.LEDGER_PROJECTION_RETENTION_MS,
  };
}
