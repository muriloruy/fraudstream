import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL_PAYMENTS: 'postgres://payments_svc:secret@db:5432/fraudstream',
  KAFKA_BROKERS: 'k1:9092, k2:9092',
  VAULT_URL: 'http://card-vault:3001/',
  VAULT_SERVICE_TOKEN: 'service-token-0123456789',
  HASH_PEPPER: 'pepper-0123456789abcdef',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 3000,
      rateLimitPerMinute: 100,
      vaultUrl: 'http://card-vault:3001',
      kafkaBrokers: ['k1:9092', 'k2:9092'],
      corsOrigins: [],
    });
  });

  it('refuses placeholders in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', HASH_PEPPER: 'change-me-change-me' }),
    ).toThrow(/HASH_PEPPER still has a placeholder/);
  });

  it('names missing variables', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL_PAYMENTS/);
  });
});
