import type { TransactionAuthorizationRequestedV1 } from '@fraudstream/contracts';
import { hashWithPepper } from '@fraudstream/security';
import type { AuthorizationRequest } from './authorization-request.js';

export interface TokenizedCard {
  cardToken: string;
  maskedPan: string;
}

/**
 * Builds the `TransactionAuthorizationRequested` payload. Card data is reduced to the vault
 * token and masked PAN; IP and device id are peppered hashes (SPEC §4.9). The CVV and the
 * PAN have no place in the result by construction.
 */
export function toAuthorizationEvent(
  request: AuthorizationRequest,
  card: TokenizedCard,
  transactionId: string,
  requestedAt: Date,
  pepper: string,
): TransactionAuthorizationRequestedV1 {
  return {
    transactionId,
    accountId: request.accountId,
    cardToken: card.cardToken,
    maskedPan: card.maskedPan,
    amount: { value: request.amount.value, currency: request.amount.currency },
    merchant: { ...request.merchant },
    channel: request.channel,
    entryMode: request.entryMode,
    device: {
      ipHash: hashWithPepper(request.device.ip, pepper),
      deviceIdHash: hashWithPepper(request.device.deviceId, pepper),
    },
    ...(request.geo ? { geo: { ...request.geo } } : {}),
    requestedAt: requestedAt.toISOString(),
  };
}
