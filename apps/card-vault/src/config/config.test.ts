import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const key = () => `base64:${randomBytes(32).toString('base64')}`;
const base = {
  DATABASE_URL_VAULT: 'postgres://vault_svc:secret@db:5432/fraudstream',
  VAULT_DEK_V1: key(),
  VAULT_HMAC_KEY: key(),
  VAULT_SERVICE_TOKEN: 'service-token-0123456789',
  VAULT_ADMIN_TOKEN: 'admin-token-0123456789ab',
};

describe('loadConfig', () => {
  it('loads every key version and activates the highest', () => {
    const config = loadConfig({ ...base, VAULT_DEK_V2: key() });
    expect(config.keyring.activeVersion).toBe(2);
    expect(config.keyring.key(1)).toHaveLength(32);
    expect(config.port).toBe(3001);
  });

  it('honours an explicit active version', () => {
    const config = loadConfig({ ...base, VAULT_DEK_V2: key(), VAULT_ACTIVE_KEY_VERSION: '1' });
    expect(config.keyring.activeVersion).toBe(1);
  });

  it('rejects placeholder or malformed keys', () => {
    expect(() =>
      loadConfig({ ...base, VAULT_DEK_V1: 'base64:REPLACE_WITH_32_RANDOM_BYTES' }),
    ).toThrow(/VAULT_DEK_V1 must be base64/);
    expect(() => loadConfig({ ...base, VAULT_HMAC_KEY: 'base64:c2hvcnQ=' })).toThrow(
      /VAULT_HMAC_KEY/,
    );
  });

  it('refuses placeholder secrets in production only', () => {
    const placeholder = { ...base, VAULT_SERVICE_TOKEN: 'change-me-change-me' };
    expect(() => loadConfig(placeholder)).not.toThrow();
    expect(() => loadConfig({ ...placeholder, NODE_ENV: 'production' })).toThrow(
      /VAULT_SERVICE_TOKEN still has a placeholder/,
    );
  });

  it('requires distinct service and admin tokens', () => {
    expect(() => loadConfig({ ...base, VAULT_ADMIN_TOKEN: base.VAULT_SERVICE_TOKEN })).toThrow(
      /must differ/,
    );
  });

  it('reports missing variables by name', () => {
    expect(() => loadConfig({ VAULT_DEK_V1: key() })).toThrow(/DATABASE_URL_VAULT/);
  });
});
