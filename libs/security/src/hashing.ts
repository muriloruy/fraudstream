import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 as lowercase hex. */
export function hmacSha256Hex(key: string | Buffer, value: string | Buffer): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/**
 * Peppered hash for identifiers that must not leave the service in clear text, such as
 * IP addresses and device ids (SPEC §4.9). A plain SHA-256 of an IPv4 address can be
 * brute-forced in seconds; keying it with a secret pepper prevents that.
 */
export function hashWithPepper(value: string, pepper: string): string {
  return `sha256:${hmacSha256Hex(pepper, value)}`;
}

/** Constant-time string comparison for tokens and secrets. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** JSON with object keys sorted recursively, so equal values always serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
