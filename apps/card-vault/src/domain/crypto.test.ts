import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptPan, encryptPan, generateCardToken, Keyring, panHmac, wipe } from './crypto.js';

const key = randomBytes(32);
const aad = Buffer.from('tok_abc');
const pan = () => Buffer.from('4111111111111111');

describe('AES-256-GCM PAN encryption', () => {
  it('round-trips', () => {
    const encrypted = encryptPan(pan(), key, aad);
    expect(decryptPan(encrypted, key, aad).toString()).toBe('4111111111111111');
    expect(encrypted.ciphertext.toString()).not.toContain('4111111111111111');
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
  });

  it('uses a fresh IV every time', () => {
    const ivs = new Set(
      Array.from({ length: 1000 }, () => encryptPan(pan(), key, aad).iv.toString('hex')),
    );
    expect(ivs.size).toBe(1000);
  });

  it('detects a tampered ciphertext or tag', () => {
    const encrypted = encryptPan(pan(), key, aad);
    const flipped = Buffer.from(encrypted.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => decryptPan({ ...encrypted, ciphertext: flipped }, key, aad)).toThrow();
    const badTag = Buffer.from(encrypted.authTag);
    badTag[0] = (badTag[0] ?? 0) ^ 0xff;
    expect(() => decryptPan({ ...encrypted, authTag: badTag }, key, aad)).toThrow();
  });

  it('fails with the wrong key or when moved to another token (AAD)', () => {
    const encrypted = encryptPan(pan(), key, aad);
    expect(() => decryptPan(encrypted, randomBytes(32), aad)).toThrow();
    expect(() => decryptPan(encrypted, key, Buffer.from('tok_other'))).toThrow();
  });
});

describe('Keyring', () => {
  it('serves keys by version and the active key', () => {
    const v2 = randomBytes(32);
    const ring = new Keyring(
      new Map([
        [1, key],
        [2, v2],
      ]),
      2,
    );
    expect(ring.activeKey()).toBe(v2);
    expect(ring.key(1)).toBe(key);
    expect(() => ring.key(3)).toThrow(RangeError);
  });

  it('rejects bad configuration', () => {
    expect(() => new Keyring(new Map([[1, randomBytes(16)]]), 1)).toThrow(/32 bytes/);
    expect(() => new Keyring(new Map([[1, key]]), 2)).toThrow(/not configured/);
  });
});

describe('panHmac and tokens', () => {
  it('is deterministic per key', () => {
    const hmacKey = randomBytes(32);
    expect(panHmac(pan(), hmacKey)).toBe(panHmac(pan(), hmacKey));
    expect(panHmac(pan(), hmacKey)).not.toBe(panHmac(pan(), randomBytes(32)));
    expect(panHmac(pan(), hmacKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique base62 tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateCardToken));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(t).toMatch(/^tok_[0-9A-Za-z]{43}$/);
  });

  it('wipes buffers', () => {
    const b = pan();
    wipe(b);
    expect([...b].every((x) => x === 0)).toBe(true);
  });
});
