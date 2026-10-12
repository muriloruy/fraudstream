import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** AES-256-GCM with a 96-bit random IV per encryption (NIST SP 800-38D). */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedPan {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Data-encryption keys by version; new data is always encrypted with the active version. */
export class Keyring {
  constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    readonly activeVersion: number,
  ) {
    for (const [version, key] of keys) {
      if (key.length !== KEY_BYTES) {
        throw new RangeError(`key v${version} must be ${KEY_BYTES} bytes`);
      }
    }
    if (!keys.has(activeVersion)) {
      throw new RangeError(`active key v${activeVersion} is not configured`);
    }
  }

  key(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new RangeError(`key v${version} is not configured`);
    return key;
  }

  activeKey(): Buffer {
    return this.key(this.activeVersion);
  }
}

/**
 * Encrypts a PAN. `aad` (the card token) is authenticated but not encrypted, binding the
 * ciphertext to its row: a ciphertext copied onto another token fails to decrypt.
 */
export function encryptPan(pan: Buffer, key: Buffer, aad: Buffer): EncryptedPan {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(pan), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Decrypts and authenticates; throws if the ciphertext, tag, IV, AAD or key do not match. */
export function decryptPan(encrypted: EncryptedPan, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

/** Deterministic lookup key: the same PAN always maps to the same HMAC (SPEC §5.2). */
export function panHmac(pan: Buffer, hmacKey: Buffer): string {
  return createHmac('sha256', hmacKey).update(pan).digest('hex');
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `tok_` + 32 random bytes in base62 (SPEC §5.2). Carries no information about the PAN. */
export function generateCardToken(): string {
  let n = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE62.charAt(Number(n % 62n)) + out;
    n /= 62n;
  }
  return `tok_${out.padStart(43, '0')}`;
}

/** Overwrites a buffer holding cardholder data once it is no longer needed (SPEC §6.2). */
export function wipe(buffer: Buffer): void {
  buffer.fill(0);
}
