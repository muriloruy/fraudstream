import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from './pool.js';

describe('resolveDatabaseUrl', () => {
  const url = 'postgres://payments_svc:s3cr%40t@localhost:5432/fraudstream';

  it('keeps the URL when no override is set', () => {
    expect(resolveDatabaseUrl(url, '')).toBe(url);
  });

  it('swaps only the host', () => {
    expect(resolveDatabaseUrl(url, 'postgres')).toBe(
      'postgres://payments_svc:s3cr%40t@postgres:5432/fraudstream',
    );
  });
});
