import { createEnvelope, TransactionAuthorizationRequested, uuidv7 } from '@fraudstream/contracts';
import { withTransaction, type Pool } from '@fraudstream/db';
import type { OutboxWriter } from '@fraudstream/outbox';
import { canonicalJson, hmacSha256Hex } from '@fraudstream/security';
import type { AuthorizationRequest } from '../domain/authorization-request.js';
import { toAuthorizationEvent } from '../domain/transaction.js';
import type {
  IdempotencyRepository,
  StoredResponse,
} from '../infrastructure/db/idempotency.repository.js';
import type { TransactionsRepository } from '../infrastructure/db/transactions.repository.js';
import type { VaultClient } from '../infrastructure/vault/vault.client.js';

export const PRODUCER = 'transaction-api';

export class IdempotencyConflictError extends Error {}
export class IdempotencyMismatchError extends Error {}

export interface AcceptedResponse {
  transactionId: string;
  status: 'PENDING';
  links: { self: string };
}

export class TransactionsService {
  constructor(
    private readonly pool: Pool,
    private readonly idempotency: IdempotencyRepository,
    private readonly transactions: TransactionsRepository,
    private readonly outbox: OutboxWriter,
    private readonly vault: VaultClient,
    private readonly pepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * SPEC §3.3 steps 1-3: claim the idempotency key, tokenize the card, then write the
   * transaction, its outbox event and the stored response in one DB transaction.
   */
  async accept(request: AuthorizationRequest, idempotencyKey: string): Promise<StoredResponse> {
    // Keyed hash: the body contains the PAN, so a plain SHA-256 would be brute-forceable.
    const requestHash = hmacSha256Hex(this.pepper, canonicalJson(request));
    const claim = await this.idempotency.claim(idempotencyKey, requestHash);
    if (claim.kind === 'replay') return claim.response;
    if (claim.kind === 'mismatch') throw new IdempotencyMismatchError();
    if (claim.kind === 'in-progress') throw new IdempotencyConflictError();

    try {
      const card = await this.vault.tokenize({
        pan: request.card.pan,
        expiryMonth: request.card.expiryMonth,
        expiryYear: request.card.expiryYear,
      });
      // The CVV was format-checked by validation (the simulated check) and goes no further.

      const transactionId = uuidv7();
      const payload = toAuthorizationEvent(request, card, transactionId, this.now(), this.pepper);
      const envelope = TransactionAuthorizationRequested.envelope.parse(
        createEnvelope({
          eventType: TransactionAuthorizationRequested.eventType,
          eventVersion: TransactionAuthorizationRequested.eventVersion,
          producer: PRODUCER,
          correlationId: transactionId,
          payload,
        }),
      );
      const response: StoredResponse = {
        status: 202,
        body: {
          transactionId,
          status: 'PENDING',
          links: { self: `/v1/transactions/${transactionId}` },
        } satisfies AcceptedResponse,
      };

      await withTransaction(this.pool, async (client) => {
        await this.transactions.insertPending(client, payload);
        await this.outbox.write(client, {
          topic: TransactionAuthorizationRequested.topic,
          key: payload.accountId,
          envelope,
        });
        await this.idempotency.complete(client, idempotencyKey, response);
      });
      return response;
    } catch (error) {
      await this.idempotency.release(idempotencyKey).catch(() => undefined);
      throw error;
    }
  }
}
