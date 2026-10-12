import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '@fraudstream/contracts';
import type { Pool } from '@fraudstream/db';

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

const CACHE_TTL_MS = 60_000;

/** API keys are stored as SHA-256 hashes; valid lookups are cached briefly (SPEC §6.1). */
export class ApiKeysRepository {
  private readonly cache = new Map<string, { keyId: string; expiresAt: number }>();

  constructor(private readonly pool: Pool) {}

  /** Returns the key id for an active key, or null. */
  async authenticate(key: string): Promise<string | null> {
    const hash = hashApiKey(key);
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > Date.now()) return cached.keyId;
    const { rows } = await this.pool.query<{ key_id: string }>(
      'SELECT key_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [hash],
    );
    const keyId = rows[0]?.key_id ?? null;
    if (keyId) this.cache.set(hash, { keyId, expiresAt: Date.now() + CACHE_TTL_MS });
    return keyId;
  }

  /** Creates a key and returns it; only its hash is stored, so it cannot be shown again. */
  async create(name: string): Promise<{ keyId: string; key: string }> {
    const key = `fsk_${randomBytes(32).toString('base64url')}`;
    const keyId = uuidv7();
    await this.pool.query('INSERT INTO api_keys (key_id, name, key_hash) VALUES ($1, $2, $3)', [
      keyId,
      name,
      hashApiKey(key),
    ]);
    return { keyId, key };
  }
}
