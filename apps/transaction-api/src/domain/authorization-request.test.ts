import { describe, expect, it } from 'vitest';
import { AuthorizationRequest } from './authorization-request.js';
import { validRequest } from './fixtures.js';

type Body = Record<string, unknown> & ReturnType<typeof validRequest>;
const parse = (mutate: (b: Body) => void) => {
  const body = structuredClone(validRequest()) as Body;
  mutate(body);
  return AuthorizationRequest.safeParse(body);
};
const fieldsOf = (r: ReturnType<typeof parse>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join('.'));

describe('AuthorizationRequest (SPEC §6.1)', () => {
  it('accepts the SPEC example', () => {
    expect(parse(() => undefined).success).toBe(true);
  });

  it.each<[string, (b: Body) => void, string]>([
    ['Luhn failure', (b) => (b.card.pan = '4111111111111112'), 'card.pan'],
    ['PAN too short', (b) => (b.card.pan = '411111111111'), 'card.pan'],
    ['PAN too long', (b) => (b.card.pan = '41111111111111111111'), 'card.pan'],
    ['PAN with separators', (b) => (b.card.pan = '4111 1111 1111 1111'), 'card.pan'],
    ['CVV of 2 digits', (b) => (b.card.cvv = '12'), 'card.cvv'],
    ['CVV of 5 digits', (b) => (b.card.cvv = '12345'), 'card.cvv'],
    ['expiry month 13', (b) => (b.card.expiryMonth = 13), 'card.expiryMonth'],
    ['zero amount', (b) => (b.amount.value = '0.00'), 'amount.value'],
    ['negative amount', (b) => (b.amount.value = '-1.00'), 'amount.value'],
    ['three decimals', (b) => (b.amount.value = '10.123'), 'amount.value'],
    ['amount over limit', (b) => (b.amount.value = '1000000.01'), 'amount.value'],
    ['unknown currency', (b) => (b.amount.currency = 'XYZ' as 'BRL'), 'amount.currency'],
    ['invalid country', (b) => (b.merchant.country = 'XX' as 'BR'), 'merchant.country'],
    ['MCC of 3 digits', (b) => (b.merchant.mcc = '573'), 'merchant.mcc'],
    ['invalid channel', (b) => (b.channel = 'PHONE' as 'POS'), 'channel'],
    ['invalid IP', (b) => (b.device.ip = '999.1.1.1'), 'device.ip'],
    ['latitude out of range', (b) => (b.geo = { lat: 91, lon: 0 }), 'geo.lat'],
    ['unknown top-level field', (b) => (b.extra = 1), ''],
  ])('rejects %s', (_label, mutate, field) => {
    const result = parse(mutate);
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toContain(field);
  });

  it('rejects unknown nested fields', () => {
    const result = parse((b) => {
      (b.card as Record<string, unknown>).track2 = 'x';
    });
    expect(result.success).toBe(false);
  });

  it('accepts the amount boundary 1000000.00 and an IPv6 address', () => {
    expect(parse((b) => (b.amount.value = '1000000.00')).success).toBe(true);
    expect(parse((b) => (b.device.ip = '2001:db8::1')).success).toBe(true);
  });

  it('allows omitting geo and merchant city', () => {
    const result = parse((b) => {
      delete (b as Partial<Body>).geo;
      delete b.merchant.city;
    });
    expect(result.success).toBe(true);
  });
});
