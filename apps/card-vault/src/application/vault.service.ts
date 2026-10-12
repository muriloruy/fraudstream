import { withTransaction, type Pool } from '@fraudstream/db';
import { maskPan } from '@fraudstream/security';
import {
  decryptPan,
  encryptPan,
  generateCardToken,
  panHmac,
  wipe,
  type Keyring,
} from '../domain/crypto.js';
import type { CardsRepository } from '../infrastructure/db/cards.repository.js';

export type VaultRole = 'service' | 'vault-admin';

export interface TokenizeInput {
  /** PAN digits; wiped by the caller after the call. */
  pan: Buffer;
  expiryMonth: number;
  expiryYear: number;
}

export interface TokenizeResult {
  cardToken: string;
  maskedPan: string;
  bin: string;
  last4: string;
}

export interface DetokenizeResult {
  pan: string;
  expiryMonth: number;
  expiryYear: number;
}

export class DetokenizeForbiddenError extends Error {}
export class CardNotFoundError extends Error {}

export class VaultService {
  constructor(
    private readonly cards: CardsRepository,
    private readonly keyring: Keyring,
    private readonly hmacKey: Buffer,
  ) {}

  /** Same card, same token: an existing HMAC match returns the stored token (SPEC §6.2). */
  async tokenize(input: TokenizeInput): Promise<TokenizeResult> {
    const hmac = panHmac(input.pan, this.hmacKey);
    const masked = maskPan(input.pan.toString('ascii'));
    const describe = (cardToken: string): TokenizeResult => ({
      cardToken,
      maskedPan: masked,
      bin: masked.slice(0, 6),
      last4: masked.slice(-4),
    });

    const existing = await this.cards.findByHmac(hmac);
    if (existing) return describe(existing.cardToken);

    const cardToken = generateCardToken();
    const encrypted = encryptPan(input.pan, this.keyring.activeKey(), Buffer.from(cardToken));
    const inserted = await this.cards.insertIfAbsent({
      cardToken,
      encrypted,
      panHmac: hmac,
      keyVersion: this.keyring.activeVersion,
      bin: masked.slice(0, 6),
      last4: masked.slice(-4),
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
    });
    if (inserted) return describe(cardToken);

    // A concurrent request stored the same card first: return its token.
    const winner = await this.cards.findByHmac(hmac);
    if (!winner) throw new Error('card vanished after HMAC conflict');
    return describe(winner.cardToken);
  }

  /**
   * Only `vault-admin` may detokenize; every attempt is audited. No service calls this:
   * it exists to demonstrate the control (SPEC §6.2).
   */
  async detokenize(cardToken: string, role: VaultRole): Promise<DetokenizeResult> {
    if (role !== 'vault-admin') {
      await this.cards.audit(role, cardToken, 'DENIED');
      throw new DetokenizeForbiddenError();
    }
    const card = await this.cards.findByToken(cardToken);
    if (!card) {
      await this.cards.audit(role, cardToken, 'NOT_FOUND');
      throw new CardNotFoundError();
    }
    const pan = decryptPan(
      card.encrypted,
      this.keyring.key(card.keyVersion),
      Buffer.from(cardToken),
    );
    try {
      await this.cards.audit(role, cardToken, 'ALLOWED');
      return {
        pan: pan.toString('ascii'),
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
      };
    } finally {
      wipe(pan);
    }
  }

  /**
   * Re-encrypts every card stored under an old key version with the active key, in batches
   * locked with SKIP LOCKED so it can run alongside traffic. Tokens never change.
   */
  async rotateKeys(pool: Pool, batchSize = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const rotated = await withTransaction(pool, async (client) => {
        const batch = await this.cards.lockStaleBatch(
          client,
          this.keyring.activeVersion,
          batchSize,
        );
        for (const card of batch) {
          const aad = Buffer.from(card.cardToken);
          const pan = decryptPan(card.encrypted, this.keyring.key(card.keyVersion), aad);
          try {
            const encrypted = encryptPan(pan, this.keyring.activeKey(), aad);
            await this.cards.reencrypt(
              client,
              card.cardToken,
              encrypted,
              this.keyring.activeVersion,
            );
          } finally {
            wipe(pan);
          }
        }
        return batch.length;
      });
      total += rotated;
      if (rotated < batchSize) return total;
    }
  }
}
