import { parseBrokers } from '@fraudstream/kafka';
import { z } from 'zod';

export interface AnomalyConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  alpha: number;
}

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3003),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_ANOMALY: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  ANOMALY_ALPHA: z.coerce.number().gt(0).lt(1).default(0.1),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnomalyConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid anomaly-scorer configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_ANOMALY,
    kafkaBrokers: parseBrokers(e.KAFKA_BROKERS),
    alpha: e.ANOMALY_ALPHA,
  };
}
