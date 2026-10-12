import {
  AccountProfileUpserted,
  FraudRulesEvaluated,
  toCents,
  TransactionAuthorizationRequested,
  type Envelope,
  type FraudRulesEvaluatedV1,
  type TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import { on, type EventHandler, type HandlerContext } from '@fraudstream/kafka';
import type { OutboxWriter } from '@fraudstream/outbox';
import { evaluate, type TransactionFacts } from '../domain/rules.js';
import type { Ruleset } from '../domain/ruleset.js';
import type { RulesRepository } from '../infrastructure/db/rules.repository.js';

export const PRODUCER = 'fraud-rules';

export function toFacts(p: TransactionAuthorizationRequestedV1): TransactionFacts {
  return {
    transactionId: p.transactionId,
    accountId: p.accountId,
    amountCents: toCents(p.amount.value),
    merchantId: p.merchant.id,
    mcc: p.merchant.mcc,
    country: p.merchant.country,
    bin: p.maskedPan.slice(0, 6),
    requestedAt: new Date(p.requestedAt),
    geo: p.geo,
  };
}

/** Builds the published result; exported for contract tests (SPEC §13.3). */
export function toResult(
  p: TransactionAuthorizationRequestedV1,
  ruleset: Ruleset,
  evaluation: ReturnType<typeof evaluate>,
  evaluatedAt: Date,
): FraudRulesEvaluatedV1 {
  return {
    transactionId: p.transactionId,
    accountId: p.accountId,
    ruleScore: Math.round(evaluation.ruleScore * 10_000) / 10_000,
    hardDecline: evaluation.hardDecline,
    firedRules: evaluation.firedRules.map(({ ruleId, name, points, details }) => ({
      ruleId,
      name,
      points,
      details,
    })),
    rulesetVersion: ruleset.version,
    evaluatedAt: evaluatedAt.toISOString(),
    requestedAt: p.requestedAt,
  };
}

/**
 * SPEC §6.4: load the account context in one query, evaluate the rules, record the
 * transaction in the activity window and publish the result, all in the consumer's DB
 * transaction (idempotent via the inbox).
 */
export function ruleHandlers(deps: {
  ruleset: Ruleset;
  repository: RulesRepository;
  outbox: OutboxWriter;
  onEvaluated?: (result: FraudRulesEvaluatedV1) => void;
}): EventHandler[] {
  const evaluateTransaction = async (
    envelope: Envelope<TransactionAuthorizationRequestedV1>,
    ctx: HandlerContext,
  ) => {
    const p = envelope.payload;
    const facts = toFacts(p);
    const context = await deps.repository.loadContext(ctx.tx, facts);
    const result = toResult(p, deps.ruleset, evaluate(facts, context, deps.ruleset), new Date());
    await deps.repository.recordActivity(ctx.tx, facts, p.amount.value);
    await deps.outbox.write(ctx.tx, {
      topic: FraudRulesEvaluated.topic,
      key: p.accountId,
      envelope: ctx.child({
        eventType: FraudRulesEvaluated.eventType,
        eventVersion: FraudRulesEvaluated.eventVersion,
        producer: PRODUCER,
        payload: result,
      }),
      traceparent: ctx.traceparent,
    });
    deps.onEvaluated?.(result);
  };

  return [
    on(TransactionAuthorizationRequested, evaluateTransaction),
    on(AccountProfileUpserted, async (envelope, ctx) => {
      await deps.repository.upsertProfile(ctx.tx, envelope.payload, envelope.occurredAt);
    }),
  ];
}
