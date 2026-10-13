import { z } from 'zod';
import { AccountId, UnitScore, UtcDateTime, UuidV7 } from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

export const Decision = z.enum(['APPROVE', 'REVIEW', 'DECLINE']);
export type Decision = z.infer<typeof Decision>;

/**
 * How the score was built, for the analyst's score breakdown (SPEC §8.2). Added in v1 as an
 * optional field (SPEC §4.10): consumers that do not know it ignore it.
 */
export const DecisionBreakdown = z.object({
  firedRules: z.array(
    z.object({
      ruleId: z.string().min(1),
      name: z.string().min(1),
      points: z.number().int().nonnegative(),
    }),
  ),
  hardDecline: z.boolean(),
  anomaly: z
    .object({
      features: z.object({
        amountZ: z.number(),
        interArrivalZ: z.number(),
        newMerchant: z.boolean(),
        hourOfDayDeviation: UnitScore,
      }),
      baselineSampleSize: z.number().int().nonnegative(),
      modelVersion: z.string().min(1),
    })
    .nullable(),
  /** Effective weights of this decision (the anomaly weight is lower during cold start). */
  weights: z.object({ rules: UnitScore, anomaly: UnitScore }),
  thresholds: z.object({ approveBelow: UnitScore, declineFrom: UnitScore }),
  configVersion: z.string().min(1),
});
export type DecisionBreakdown = z.infer<typeof DecisionBreakdown>;

/** `fraud.decisions.v1` (SPEC §4.9). A component is null when it timed out (`partial`). */
export const FraudDecisionMadeV1 = z.object({
  transactionId: UuidV7,
  accountId: AccountId,
  decision: Decision,
  finalScore: UnitScore,
  components: z.object({
    ruleScore: UnitScore.nullable(),
    anomalyScore: UnitScore.nullable(),
  }),
  reasons: z.array(z.string().min(1)),
  partial: z.boolean(),
  decidedAt: UtcDateTime,
  latencyMs: z.number().int().nonnegative(),
  breakdown: DecisionBreakdown.optional(),
});
export type FraudDecisionMadeV1 = z.infer<typeof FraudDecisionMadeV1>;

export const FraudDecisionMade = defineEvent({
  eventType: 'FraudDecisionMade',
  eventVersion: 1,
  topic: Topics.decisions,
  payload: FraudDecisionMadeV1,
});
