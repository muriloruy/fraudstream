import type { TokenizedCard } from '../../domain/transaction.js';

export class VaultUnavailableError extends Error {}
export class CardRejectedError extends Error {}

export interface CardToTokenize {
  pan: string;
  expiryMonth: number;
  expiryYear: number;
}

/** HTTP client for card-vault's internal tokenize endpoint (SPEC §6.2). */
export class VaultClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly timeoutMs: number,
  ) {}

  async tokenize(card: CardToTokenize): Promise<TokenizedCard> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/tokenize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.serviceToken}`,
        },
        body: JSON.stringify(card),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Never include the request in the error: it carries the PAN.
      throw new VaultUnavailableError('vault unreachable');
    }
    if (response.status === 400) throw new CardRejectedError('vault rejected the card');
    if (!response.ok) throw new VaultUnavailableError(`vault answered ${response.status}`);
    const body = (await response.json()) as Partial<TokenizedCard>;
    if (typeof body.cardToken !== 'string' || typeof body.maskedPan !== 'string') {
      throw new VaultUnavailableError('unexpected vault response');
    }
    return { cardToken: body.cardToken, maskedPan: body.maskedPan };
  }
}
