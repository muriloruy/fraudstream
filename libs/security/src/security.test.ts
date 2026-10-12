import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  hashWithPepper,
  isValidPan,
  luhnValid,
  maskPan,
  REDACT_PATHS,
  safeEqual,
} from './index.js';

describe('luhnValid', () => {
  it.each([
    ['4111111111111111', true],
    ['5555555555554444', true],
    ['378282246310005', true], // Amex, 15 digits
    ['4222222222222', true], // 13 digits
    ['4111111111111112', false],
    ['0000000000000001', false],
    ['4111-1111-1111-1111', false],
    ['', false],
  ])('%s -> %s', (pan, expected) => {
    expect(luhnValid(pan)).toBe(expected);
  });
});

describe('isValidPan', () => {
  it('requires 13 to 19 digits and a valid Luhn digit', () => {
    expect(isValidPan('4111111111111111')).toBe(true);
    expect(isValidPan('42424242424')).toBe(false); // too short
    expect(isValidPan('42424242424242424242')).toBe(false); // 20 digits
  });
});

describe('maskPan', () => {
  it('keeps first 6 and last 4, always 16 characters', () => {
    expect(maskPan('4111111111111111')).toBe('411111******1111');
    expect(maskPan('378282246310005')).toBe('378282******0005');
    expect(maskPan('4222222222222')).toHaveLength(16);
  });

  it('rejects non-PAN input', () => {
    expect(() => maskPan('4111')).toThrow(RangeError);
  });
});

describe('hashing', () => {
  it('is deterministic per pepper and hides the input', () => {
    const a = hashWithPepper('203.0.113.10', 'pepper-1');
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toBe(hashWithPepper('203.0.113.10', 'pepper-1'));
    expect(a).not.toBe(hashWithPepper('203.0.113.10', 'pepper-2'));
    expect(a).not.toContain('203.0.113.10');
  });

  it('compares secrets in constant time', () => {
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'tokeN')).toBe(false);
    expect(safeEqual('token', 'token-longer')).toBe(false);
  });

  it('serializes objects canonically', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('REDACT_PATHS', () => {
  it('covers card data and credentials at several depths', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining(['pan', '*.pan', '*.*.cvv', '*.card', 'password', '*["x-api-key"]']),
    );
  });
});

describe('secrets', async () => {
  const { decodeBase64Key, isPlaceholderSecret } = await import('./index.js');

  it('detects .env.example placeholders', () => {
    expect(isPlaceholderSecret('change-me')).toBe(true);
    expect(isPlaceholderSecret('base64:REPLACE_WITH_32_RANDOM_BYTES')).toBe(true);
    expect(isPlaceholderSecret('9f8c2b...')).toBe(false);
  });

  it('decodes base64 keys of the right size only', () => {
    const raw = Buffer.alloc(32, 7);
    expect(decodeBase64Key('K', `base64:${raw.toString('base64')}`, 32)).toEqual(raw);
    expect(() => decodeBase64Key('K', 'base64:REPLACE_WITH_32_RANDOM_BYTES', 32)).toThrow(
      /K must be/,
    );
    expect(() => decodeBase64Key('K', raw.toString('base64'), 32)).toThrow(/K must be/);
  });
});
