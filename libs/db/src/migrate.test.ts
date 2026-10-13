import { describe, expect, it } from 'vitest';
import { schemaLockValue } from './migrate.js';

describe('schemaLockValue', () => {
  it('is a stable signed 32-bit key, distinct per service schema', () => {
    const schemas = [
      'payments',
      'vault',
      'fraud_rules',
      'anomaly',
      'decisions',
      'ledger',
      'alerts',
      'auth',
    ];
    const keys = schemas.map(schemaLockValue);
    expect(new Set(keys).size).toBe(schemas.length);
    for (const key of keys) {
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThan(2 ** 31);
    }
    expect(schemaLockValue('ledger')).toBe(schemaLockValue('ledger'));
  });
});
