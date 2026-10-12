import { z } from 'zod';
import { AccountId, UnitScore, UtcDateTime, UuidV7 } from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

export const Decision = z.enum(['APPROVE', 'REVIEW', 'DECLINE']);
export type Decision = z.infer<typeof Decision>;

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
});
export type FraudDecisionMadeV1 = z.infer<typeof FraudDecisionMadeV1>;

export const FraudDecisionMade = defineEvent({
  eventType: 'FraudDecisionMade',
  eventVersion: 1,
  topic: Topics.decisions,
  payload: FraudDecisionMadeV1,
});
