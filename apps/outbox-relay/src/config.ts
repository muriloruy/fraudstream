import { parseBrokers } from '@fraudstream/kafka';
import { assertSchemaName } from '@fraudstream/outbox';
import { z } from 'zod';

export interface RelayConfig {
  schema: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  batchSize: number;
  pollMs: number;
  metricsPort: number;
  deliveryTimeoutMs: number;
  logLevel: string;
}

const Env = z.object({
  RELAY_SCHEMA: z.string().default('payments'),
  RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
  RELAY_POLL_MS: z.coerce.number().int().min(1).default(100),
  RELAY_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  METRICS_PORT: z.coerce.number().int().positive().default(9464),
  KAFKA_BROKERS: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
});

/** One relay instance serves one schema; its DB URL is `DATABASE_URL_<SCHEMA>` (SPEC §6.3). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid outbox-relay configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;
  const schema = assertSchemaName(e.RELAY_SCHEMA);
  const urlVar = `DATABASE_URL_${schema.toUpperCase()}`;
  // urlVar is built from a validated identifier, not from request data.
  // eslint-disable-next-line security/detect-object-injection
  const databaseUrl = env[urlVar];
  if (!databaseUrl) throw new Error(`${urlVar} is not set`);
  return {
    schema,
    databaseUrl,
    kafkaBrokers: parseBrokers(e.KAFKA_BROKERS),
    batchSize: e.RELAY_BATCH_SIZE,
    pollMs: e.RELAY_POLL_MS,
    metricsPort: e.METRICS_PORT,
    deliveryTimeoutMs: e.RELAY_DELIVERY_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
  };
}
