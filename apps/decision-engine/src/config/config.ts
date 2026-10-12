import { parseBrokers } from '@fraudstream/kafka';
import { z } from 'zod';
import { DEFAULT_FUSION, type FusionConfig } from '../domain/fusion.js';

export interface DecisionConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  fusion: FusionConfig & { joinTimeoutMs: number };
  sweepIntervalMs: number;
}

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3004),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL_DECISION: z.string().min(1),
    KAFKA_BROKERS: z.string().min(1),
    DECISION_APPROVE_BELOW: z.coerce.number().gt(0).lt(1).default(0.4),
    DECISION_DECLINE_FROM: z.coerce.number().gt(0).lte(1).default(0.75),
    DECISION_JOIN_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    DECISION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  })
  .refine((e) => e.DECISION_APPROVE_BELOW < e.DECISION_DECLINE_FROM, {
    message: 'DECISION_APPROVE_BELOW must be lower than DECISION_DECLINE_FROM',
  });

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DecisionConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`invalid decision-engine configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_DECISION,
    kafkaBrokers: parseBrokers(e.KAFKA_BROKERS),
    fusion: {
      ...DEFAULT_FUSION,
      approveBelow: e.DECISION_APPROVE_BELOW,
      declineFrom: e.DECISION_DECLINE_FROM,
      joinTimeoutMs: e.DECISION_JOIN_TIMEOUT_MS,
    },
    sweepIntervalMs: e.DECISION_SWEEP_INTERVAL_MS,
  };
}
