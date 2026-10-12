import { describe, expect, it } from 'vitest';
import {
  CardToken,
  CountryCode,
  CurrencyCode,
  DecimalString,
  MaskedPan,
  Mcc,
  Money,
  Sha256Hash,
  toCents,
  UtcDateTime,
  UuidV7,
  AccountId,
} from './primitives.js';

describe('DecimalString / Money (ADR-009)', () => {
  it.each(['0', '1', '10.5', '1250.90', '1000000.00', '9999999999999999.99'])('accepts %s', (v) => {
    expect(DecimalString.safeParse(v).success).toBe(true);
  });

  it.each(['10.123', '01.00', '-1.00', '1e3', '1,00', '.50', '1.', '', ' 1.00'])(
    'rejects %j',
    (v) => {
      expect(DecimalString.safeParse(v).success).toBe(false);
    },
  );

  it('rejects a JSON number amount', () => {
    expect(Money.safeParse({ value: 1250.9, currency: 'BRL' }).success).toBe(false);
  });

  it('rejects a zero amount', () => {
    expect(Money.safeParse({ value: '0.00', currency: 'BRL' }).success).toBe(false);
  });

  it('rejects a currency outside the allow-list', () => {
    expect(Money.safeParse({ value: '1.00', currency: 'XYZ' }).success).toBe(false);
    expect(CurrencyCode.safeParse('brl').success).toBe(false);
  });

  it('converts decimal strings to exact cents', () => {
    expect(toCents('1250.9')).toBe(125090n);
    expect(toCents('0.01')).toBe(1n);
    expect(toCents('9999999999999999.99')).toBe(999999999999999999n);
    expect(() => toCents('1.234')).toThrow(RangeError);
  });
});

describe('codes', () => {
  it('validates ISO 3166-1 alpha-2 countries', () => {
    expect(CountryCode.safeParse('BR').success).toBe(true);
    expect(CountryCode.safeParse('PT').success).toBe(true);
    expect(CountryCode.safeParse('XX').success).toBe(false);
    expect(CountryCode.safeParse('br').success).toBe(false);
  });

  it('validates 4-digit MCCs', () => {
    expect(Mcc.safeParse('5732').success).toBe(true);
    expect(Mcc.safeParse('573').success).toBe(false);
    expect(Mcc.safeParse('57a2').success).toBe(false);
  });
});

describe('card data', () => {
  it('accepts a masked PAN', () => {
    expect(MaskedPan.safeParse('411111******1111').success).toBe(true);
  });

  it('rejects an unmasked PAN', () => {
    expect(MaskedPan.safeParse('4111111111111111').success).toBe(false);
    expect(MaskedPan.safeParse('4111******1111').success).toBe(false);
  });

  it('validates vault tokens and hashes', () => {
    expect(CardToken.safeParse('tok_9f8cA1b2C3d4E5f6G7h8').success).toBe(true);
    expect(CardToken.safeParse('4111111111111111').success).toBe(false);
    expect(Sha256Hash.safeParse(`sha256:${'a'.repeat(64)}`).success).toBe(true);
    expect(Sha256Hash.safeParse('203.0.113.10').success).toBe(false);
  });
});

describe('ids and timestamps', () => {
  it('accepts only UUIDv7', () => {
    expect(UuidV7.safeParse('0192f1a2-7c3e-7a10-8b2c-1d2e3f405162').success).toBe(true);
    expect(UuidV7.safeParse('9b2f5c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f').success).toBe(false);
  });

  it('accepts only UTC ISO timestamps', () => {
    expect(UtcDateTime.safeParse('2026-10-12T18:00:00.000Z').success).toBe(true);
    expect(UtcDateTime.safeParse('2026-10-12T15:00:00.000-03:00').success).toBe(false);
    expect(UtcDateTime.safeParse('2026-10-12').success).toBe(false);
  });
});

describe('identifiers', () => {
  it('allow-lists letters, digits, underscore and dash', () => {
    expect(AccountId.safeParse('acc_000123').success).toBe(true);
    expect(AccountId.safeParse("acc'; DROP TABLE x;--").success).toBe(false);
    expect(AccountId.safeParse('').success).toBe(false);
    expect(AccountId.safeParse('a'.repeat(65)).success).toBe(false);
  });
});
