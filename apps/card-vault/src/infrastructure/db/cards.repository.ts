import type { Pool, PoolClient } from '@fraudstream/db';
import type { EncryptedPan } from '../../domain/crypto.js';

export interface CardRow {
  cardToken: string;
  encrypted: EncryptedPan;
  keyVersion: number;
  bin: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
}

export interface NewCard extends CardRow {
  panHmac: string;
}

interface DbCardRow {
  card_token: string;
  pan_ciphertext: Buffer;
  pan_iv: Buffer;
  pan_auth_tag: Buffer;
  key_version: number;
  bin: string;
  last4: string;
  expiry_month: number;
  expiry_year: number;
}

const toCard = (r: DbCardRow): CardRow => ({
  cardToken: r.card_token,
  encrypted: { ciphertext: r.pan_ciphertext, iv: r.pan_iv, authTag: r.pan_auth_tag },
  keyVersion: r.key_version,
  bin: r.bin,
  last4: r.last4,
  expiryMonth: r.expiry_month,
  expiryYear: r.expiry_year,
});

const CARD_COLUMNS =
  'card_token, pan_ciphertext, pan_iv, pan_auth_tag, key_version, bin, last4, expiry_month, expiry_year';

// Built once from constants; values are always bound as parameters.
const SELECT_BY_HMAC = `SELECT ${CARD_COLUMNS} FROM cards WHERE pan_hmac = $1`;
const SELECT_BY_TOKEN = `SELECT ${CARD_COLUMNS} FROM cards WHERE card_token = $1`;
const LOCK_STALE_BATCH = `SELECT ${CARD_COLUMNS} FROM cards
  WHERE key_version <> $1
  ORDER BY card_token
  LIMIT $2
  FOR UPDATE SKIP LOCKED`;

export type AuditOutcome = 'ALLOWED' | 'DENIED' | 'NOT_FOUND';

export class CardsRepository {
  constructor(private readonly pool: Pool) {}

  async findByHmac(panHmac: string): Promise<CardRow | null> {
    const { rows } = await this.pool.query<DbCardRow>(SELECT_BY_HMAC, [panHmac]);
    return rows[0] ? toCard(rows[0]) : null;
  }

  async findByToken(cardToken: string): Promise<CardRow | null> {
    const { rows } = await this.pool.query<DbCardRow>(SELECT_BY_TOKEN, [cardToken]);
    return rows[0] ? toCard(rows[0]) : null;
  }

  /** Inserts unless the same card (HMAC) already exists; returns false on that conflict. */
  async insertIfAbsent(card: NewCard): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO cards (card_token, pan_ciphertext, pan_iv, pan_auth_tag, pan_hmac, key_version,
                          bin, last4, expiry_month, expiry_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (pan_hmac) DO NOTHING`,
      [
        card.cardToken,
        card.encrypted.ciphertext,
        card.encrypted.iv,
        card.encrypted.authTag,
        card.panHmac,
        card.keyVersion,
        card.bin,
        card.last4,
        card.expiryMonth,
        card.expiryYear,
      ],
    );
    return result.rowCount === 1;
  }

  async audit(actorRole: string, cardToken: string, outcome: AuditOutcome): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (actor_role, action, card_token, outcome) VALUES ($1, 'DETOKENIZE', $2, $3)`,
      [actorRole, cardToken, outcome],
    );
  }

  /** Locks a batch of cards still encrypted with another key version (rotation). */
  async lockStaleBatch(
    client: PoolClient,
    activeVersion: number,
    limit: number,
  ): Promise<CardRow[]> {
    const { rows } = await client.query<DbCardRow>(LOCK_STALE_BATCH, [activeVersion, limit]);
    return rows.map(toCard);
  }

  async reencrypt(
    client: PoolClient,
    cardToken: string,
    encrypted: EncryptedPan,
    keyVersion: number,
  ): Promise<void> {
    await client.query(
      `UPDATE cards SET pan_ciphertext = $2, pan_iv = $3, pan_auth_tag = $4, key_version = $5
        WHERE card_token = $1`,
      [cardToken, encrypted.ciphertext, encrypted.iv, encrypted.authTag, keyVersion],
    );
  }
}
