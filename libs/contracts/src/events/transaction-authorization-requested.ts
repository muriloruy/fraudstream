import { z } from 'zod';
import {
  AccountId,
  CardToken,
  CountryCode,
  MaskedPan,
  Mcc,
  MerchantId,
  Money,
  Sha256Hash,
  UtcDateTime,
  UuidV7,
} from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

export const Channel = z.enum(['ECOMMERCE', 'POS', 'ATM']);
export const EntryMode = z.enum(['CARD_NOT_PRESENT', 'CHIP', 'CONTACTLESS', 'MAGNETIC_STRIPE']);

export const Merchant = z.object({
  id: MerchantId,
  name: z.string().min(1).max(200),
  mcc: Mcc,
  country: CountryCode,
  city: z.string().max(200).optional(),
});

export const Geo = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** `payments.transactions.v1` (SPEC §4.9). Carries only token + masked PAN, never the PAN. */
export const TransactionAuthorizationRequestedV1 = z.object({
  transactionId: UuidV7,
  accountId: AccountId,
  cardToken: CardToken,
  maskedPan: MaskedPan,
  amount: Money,
  merchant: Merchant,
  channel: Channel,
  entryMode: EntryMode,
  device: z.object({
    ipHash: Sha256Hash,
    deviceIdHash: Sha256Hash,
  }),
  geo: Geo.optional(),
  requestedAt: UtcDateTime,
});
export type TransactionAuthorizationRequestedV1 = z.infer<
  typeof TransactionAuthorizationRequestedV1
>;

export const TransactionAuthorizationRequested = defineEvent({
  eventType: 'TransactionAuthorizationRequested',
  eventVersion: 1,
  topic: Topics.transactions,
  payload: TransactionAuthorizationRequestedV1,
});
