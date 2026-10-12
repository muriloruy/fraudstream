import {
  AccountProfileUpserted,
  AnalystFeedbackRecorded,
  AnomalyScored,
  localHour,
  TransactionAuthorizationRequested,
  type AnomalyScoredV1,
  type TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import { on, type EventHandler } from '@fraudstream/kafka';
import type { Logger } from '@fraudstream/observability';
import type { OutboxWriter } from '@fraudstream/outbox';
import {
  MODEL_VERSION,
  revert,
  score,
  update,
  type Observation,
  type Score,
} from '../domain/scoring.js';
import type { AnomalyRepository } from '../infrastructure/db/anomaly.repository.js';

export const PRODUCER = 'anomaly-scorer';

export function toObservation(
  p: TransactionAuthorizationRequestedV1,
  newMerchant: boolean,
): Observation {
  return {
    // Only ln(amount) feeds the statistics; a double is exact enough here (not money math).
    amount: Number(p.amount.value),
    at: p.requestedAt,
    hour: localHour(p.merchant.country, p.requestedAt),
    newMerchant,
  };
}

/** The published score; exported for contract tests (SPEC §13.3). */
export function toScored(
  p: TransactionAuthorizationRequestedV1,
  s: Score,
  scoredAt: Date,
): AnomalyScoredV1 {
  return {
    transactionId: p.transactionId,
    accountId: p.accountId,
    anomalyScore: s.anomalyScore,
    features: s.features,
    baselineSampleSize: s.baselineSampleSize,
    modelVersion: MODEL_VERSION,
    scoredAt: scoredAt.toISOString(),
    requestedAt: p.requestedAt,
  };
}

export function anomalyHandlers(deps: {
  repository: AnomalyRepository;
  outbox: OutboxWriter;
  alpha: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
}): EventHandler[] {
  const { repository: repo, alpha } = deps;
  return [
    on(TransactionAuthorizationRequested, async (envelope, ctx) => {
      const p = envelope.payload;
      // FOR UPDATE: one writer per account (also guaranteed by keying on accountId).
      const prior = await repo.lockBaseline(ctx.tx, p.accountId);
      const tier = await repo.tierOf(ctx.tx, p.accountId);
      const isNew = await repo.rememberMerchant(ctx.tx, p.accountId, p.merchant.id, p.requestedAt);
      const observation = toObservation(p, isNew);
      const result = score(prior, tier, observation); // against the baseline BEFORE this transaction
      await repo.saveBaseline(ctx.tx, p.accountId, update(prior, tier, observation, alpha));
      await repo.addContribution(ctx.tx, p.accountId, {
        transactionId: p.transactionId,
        prior,
        tier,
        observation,
      });
      await deps.outbox.write(ctx.tx, {
        topic: AnomalyScored.topic,
        key: p.accountId,
        envelope: ctx.child({
          eventType: AnomalyScored.eventType,
          eventVersion: AnomalyScored.eventVersion,
          producer: PRODUCER,
          payload: toScored(p, result, new Date()),
        }),
        traceparent: ctx.traceparent,
      });
    }),

    on(AccountProfileUpserted, async (envelope, ctx) => {
      await repo.upsertTier(
        ctx.tx,
        envelope.payload.accountId,
        envelope.payload.riskTier,
        envelope.occurredAt,
      );
    }),

    // Confirmed fraud must not teach the baseline what "normal" is (SPEC §6.5).
    on(AnalystFeedbackRecorded, async (envelope, ctx) => {
      const { verdict, transactionId, accountId } = envelope.payload;
      if (verdict !== 'CONFIRMED_FRAUD') return;
      await repo.lockBaseline(ctx.tx, accountId);
      const contributions = await repo.contributionsOf(ctx.tx, accountId);
      const reverted = revert(contributions, transactionId, alpha);
      if (!reverted) {
        deps.logger?.warn(
          { transactionId },
          'confirmed fraud is outside the last 50 contributions; baseline kept',
        );
        return;
      }
      await repo.saveBaseline(ctx.tx, accountId, reverted.baseline);
      for (const c of reverted.rewritten) await repo.rewritePrior(ctx.tx, c.transactionId, c.prior);
      await repo.deleteContribution(ctx.tx, transactionId);
      deps.logger?.info({ transactionId, accountId }, 'confirmed fraud removed from the baseline');
    }),
  ];
}
