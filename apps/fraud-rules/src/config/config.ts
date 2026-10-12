import { parseBrokers } from '@fraudstream/kafka';
import { z } from 'zod';
import { DEFAULT_RULES_FILE } from './ruleset-loader.js';

export interface FraudRulesConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  rulesFile: string;
}

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL_FRAUD_RULES: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  RULES_FILE: z.string().default(DEFAULT_RULES_FILE),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FraudRulesConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid fraud-rules configuration: ${fields.join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL_FRAUD_RULES,
    kafkaBrokers: parseBrokers(e.KAFKA_BROKERS),
    rulesFile: e.RULES_FILE,
  };
}
