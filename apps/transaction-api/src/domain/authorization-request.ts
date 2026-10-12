import {
  AccountId,
  Channel,
  CountryCode,
  CurrencyCode,
  EntryMode,
  isDecimalString,
  Mcc,
  MerchantId,
  PositiveDecimalString,
  toCents,
} from '@fraudstream/contracts';
import { isValidPan } from '@fraudstream/security';
import { z } from 'zod';

/** 1,000,000.00 in cents (SPEC §6.1). */
const MAX_AMOUNT_CENTS = 100_000_000n;

/**
 * `POST /v1/transactions` body (SPEC §6.1). Strict at every level: unknown fields are
 * rejected, unlike event consumers, which tolerate them (SPEC §4.10).
 */
export const AuthorizationRequest = z.strictObject({
  accountId: AccountId,
  card: z.strictObject({
    pan: z.string().refine(isValidPan, 'must be 13-19 digits with a valid Luhn check digit'),
    expiryMonth: z.number().int().min(1).max(12),
    expiryYear: z.number().int().min(2000).max(2100),
    // Used only to simulate a check, then dropped; never stored (PCI DSS 3.3.1).
    cvv: z.string().regex(/^\d{3,4}$/, 'must be 3 or 4 digits'),
  }),
  amount: z.strictObject({
    value: PositiveDecimalString.refine(
      (v) => isDecimalString(v) && toCents(v) <= MAX_AMOUNT_CENTS,
      'must not exceed 1000000.00',
    ),
    currency: CurrencyCode,
  }),
  merchant: z.strictObject({
    id: MerchantId,
    name: z.string().min(1).max(200),
    mcc: Mcc,
    country: CountryCode,
    city: z.string().min(1).max(200).optional(),
  }),
  channel: Channel,
  entryMode: EntryMode,
  device: z.strictObject({
    ip: z.union([z.ipv4(), z.ipv6()]),
    deviceId: z.string().min(1).max(200),
  }),
  geo: z
    .strictObject({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
    .optional(),
});
export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>;
