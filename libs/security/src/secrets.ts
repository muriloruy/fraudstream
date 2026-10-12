/** Values from `.env.example` that must never reach production (SPEC §14.3). */
export function isPlaceholderSecret(value: string): boolean {
  return /change-me|REPLACE/i.test(value);
}

/**
 * Decodes `base64:<data>` into a key of exactly `bytes` bytes.
 * Generate one with: `openssl rand -base64 32`.
 */
export function decodeBase64Key(name: string, value: string, bytes: number): Buffer {
  const match = /^base64:(.+)$/.exec(value);
  const key = match?.[1] ? Buffer.from(match[1], 'base64') : Buffer.alloc(0);
  if (key.length !== bytes) {
    throw new Error(
      `${name} must be base64:<${bytes} random bytes>; generate one with: openssl rand -base64 ${bytes} (or run pnpm env:init)`,
    );
  }
  return key;
}
