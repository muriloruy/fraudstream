import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('reads the schema and its DATABASE_URL_<SCHEMA>', () => {
    const config = loadConfig({
      RELAY_SCHEMA: 'fraud_rules',
      DATABASE_URL_FRAUD_RULES: 'postgres://fraud_rules_svc:x@db/fraudstream',
      KAFKA_BROKERS: 'k:9092',
    });
    expect(config).toMatchObject({
      schema: 'fraud_rules',
      databaseUrl: 'postgres://fraud_rules_svc:x@db/fraudstream',
      batchSize: 500,
      pollMs: 100,
      metricsPort: 9464,
    });
  });

  it('rejects a missing URL or an invalid schema', () => {
    expect(() => loadConfig({ KAFKA_BROKERS: 'k:9092' })).toThrow(/DATABASE_URL_PAYMENTS/);
    expect(() => loadConfig({ RELAY_SCHEMA: 'x;drop', KAFKA_BROKERS: 'k:9092' })).toThrow(
      /invalid schema/,
    );
  });
});
