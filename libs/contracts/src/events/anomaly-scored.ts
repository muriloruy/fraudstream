import { z } from 'zod';
import { AccountId, UnitScore, UtcDateTime, UuidV7 } from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

/** `fraud.scores.v1` (SPEC §4.9). */
export const AnomalyScoredV1 = z.object({
  transactionId: UuidV7,
  accountId: AccountId,
  anomalyScore: UnitScore,
  features: z.object({
    amountZ: z.number(),
    interArrivalZ: z.number(),
    newMerchant: z.boolean(),
    hourOfDayDeviation: UnitScore,
  }),
  baselineSampleSize: z.number().int().nonnegative(),
  modelVersion: z.string().min(1),
  scoredAt: UtcDateTime,
});
export type AnomalyScoredV1 = z.infer<typeof AnomalyScoredV1>;

export const AnomalyScored = defineEvent({
  eventType: 'AnomalyScored',
  eventVersion: 1,
  topic: Topics.scores,
  payload: AnomalyScoredV1,
});
