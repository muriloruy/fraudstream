import { z } from 'zod';
import { AccountId, UnitScore, UtcDateTime, UuidV7 } from '../primitives.js';
import { Topics } from '../topics.js';
import { defineEvent } from './define.js';

export const FiredRule = z.object({
  ruleId: z.string().regex(/^R\d{3}$/, 'must look like R001'),
  name: z.string().min(1),
  points: z.number().int().nonnegative(),
  details: z.record(z.string(), z.unknown()),
});

/** `fraud.rule-results.v1` (SPEC §4.9). */
export const FraudRulesEvaluatedV1 = z.object({
  transactionId: UuidV7,
  accountId: AccountId,
  ruleScore: UnitScore,
  hardDecline: z.boolean(),
  firedRules: z.array(FiredRule),
  rulesetVersion: z.string().min(1),
  evaluatedAt: UtcDateTime,
  /** Copied from the transaction so decision latency can be measured downstream (added in v1, optional). */
  requestedAt: UtcDateTime.optional(),
});
export type FraudRulesEvaluatedV1 = z.infer<typeof FraudRulesEvaluatedV1>;

export const FraudRulesEvaluated = defineEvent({
  eventType: 'FraudRulesEvaluated',
  eventVersion: 1,
  topic: Topics.ruleResults,
  payload: FraudRulesEvaluatedV1,
});
