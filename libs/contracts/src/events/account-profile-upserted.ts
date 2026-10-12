import { z } from 'zod';
import { AccountId, CountryCode, DecimalString, UtcDateTime } from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

export const RiskTier = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type RiskTier = z.infer<typeof RiskTier>;

/**
 * `accounts.profiles.v1` (SPEC §4.9). The topic is compacted: a record with a null value
 * for an account key is a tombstone and is not parsed with this schema.
 */
export const AccountProfileUpsertedV1 = z.object({
  accountId: AccountId,
  homeCountry: CountryCode,
  homeCity: z.string().max(200).nullable().optional(),
  createdAt: UtcDateTime,
  riskTier: RiskTier,
  creditLimit: DecimalString,
});
export type AccountProfileUpsertedV1 = z.infer<typeof AccountProfileUpsertedV1>;

export const AccountProfileUpserted = defineEvent({
  eventType: 'AccountProfileUpserted',
  eventVersion: 1,
  topic: Topics.accountProfiles,
  payload: AccountProfileUpsertedV1,
});
