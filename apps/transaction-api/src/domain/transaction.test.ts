import { TransactionAuthorizationRequested } from '@fraudstream/contracts';
import { describe, expect, it } from 'vitest';
import { validRequest } from './fixtures.js';
import { toAuthorizationEvent } from './transaction.js';

const card = { cardToken: 'tok_9f8cA1b2C3d4E5f6G7h8I9j0K1l2', maskedPan: '411111******1111' };

describe('toAuthorizationEvent', () => {
  const event = toAuthorizationEvent(
    validRequest(),
    card,
    '0192f1a2-7c3e-7a10-8b2c-1d2e3f405162',
    new Date('2026-10-12T18:00:00.000Z'),
    'pepper-0123456789',
  );
  const json = JSON.stringify(event);

  it('matches the v1 contract', () => {
    expect(TransactionAuthorizationRequested.payload.safeParse(event).success).toBe(true);
    expect(event.requestedAt).toBe('2026-10-12T18:00:00.000Z');
  });

  it('carries no PAN, CVV, raw IP or raw device id', () => {
    expect(json).not.toContain('4111111111111111');
    expect(json).not.toMatch(/cvv/i);
    expect(json).not.toContain('"123"');
    expect(json).not.toContain('203.0.113.10');
    expect(json).not.toContain('d-123');
    expect(event.device.ipHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps the money value as the original decimal string', () => {
    expect(event.amount).toEqual({ value: '1250.90', currency: 'BRL' });
  });
});
