import { randomUUID } from 'node:crypto';
import {
  AccountProfileUpserted,
  AnalystFeedbackRecorded,
  fromCents,
  toCents,
  createEnvelope,
  FraudDecisionMade,
  LedgerEntriesPosted,
  TransactionAuthorizationRequested,
  type AnalystFeedbackRecordedV1,
  type FraudDecisionMadeV1,
} from '@fraudstream/contracts';
import { withTransaction, type Pool } from '@fraudstream/db';
import { on, TransientError, type EventHandler } from '@fraudstream/kafka';
import type { OutboxWriter } from '@fraudstream/outbox';
import type { Principal } from '../auth/tokens.js';
import { summarize, type Summary } from '../domain/stats.js';
import type { AuditRepository } from '../infrastructure/db/audit.repository.js';
import type {
  Alert,
  AlertFilter,
  AlertsRepository,
  Verdict,
} from '../infrastructure/db/alerts.repository.js';
import type { EventBus } from '../stream/event-bus.js';

export const PRODUCER = 'alerts-gateway';

export class AlertNotFoundError extends Error {}
export class AlertAlreadyResolvedError extends Error {}

/** Builds the feedback event; exported for contract tests (SPEC §13.3). */
export function toFeedbackEvent(
  alert: Pick<Alert, 'alertId' | 'transactionId' | 'accountId'>,
  verdict: Verdict,
  analystId: string,
  note: string,
  recordedAt: Date,
): AnalystFeedbackRecordedV1 {
  return {
    transactionId: alert.transactionId,
    accountId: alert.accountId,
    alertId: alert.alertId,
    verdict,
    analystId,
    note,
    recordedAt: recordedAt.toISOString(),
  };
}

/** What the stream shows of an alert: no snapshot (the client fetches details over REST). */
const streamView = (a: Alert) => ({
  alertId: a.alertId,
  transactionId: a.transactionId,
  accountId: a.accountId,
  decision: a.decision,
  finalScore: a.finalScore,
  status: a.status,
  assignedTo: a.assignedTo,
  createdAt: a.createdAt,
});

export class AlertsService {
  constructor(
    private readonly pool: Pool,
    private readonly alerts: AlertsRepository,
    private readonly audit: AuditRepository,
    private readonly outbox: OutboxWriter,
    private readonly bus: EventBus,
    private readonly decisionSampleRate: number,
    private readonly random: () => number = Math.random,
  ) {}

  // ---- consumers (SPEC §6.8) ---------------------------------------------------------------

  handlers(): EventHandler[] {
    return [
      on(TransactionAuthorizationRequested, async (envelope, ctx) => {
        await this.alerts.rememberTransaction(ctx.tx, envelope.payload);
      }),

      on(FraudDecisionMade, async (envelope, ctx) => {
        const d = envelope.payload;
        const isNew = await this.alerts.recordAccountEvent(ctx.tx, {
          accountId: d.accountId,
          kind: 'DECISION',
          transactionId: d.transactionId,
          occurredAt: d.decidedAt,
          payload: d,
        });
        if (isNew) await this.alerts.countDecision(ctx.tx, d);
        if (isNew && this.random() < this.decisionSampleRate) {
          ctx.afterCommit(() => this.bus.publish('decision.made', d));
        }
        if (d.decision === 'APPROVE') return;

        const transaction = await this.alerts.transactionDetails(ctx.tx, d.transactionId);
        if (!transaction) {
          // Topics are not ordered relative to each other: wait for the transaction (retry topic).
          throw new TransientError(`transaction ${d.transactionId} not seen yet`);
        }
        const alert = await this.alerts.createAlert(
          ctx.tx,
          { ...d, decision: d.decision },
          randomUUID(),
          snapshotOf(d, transaction),
        );
        if (alert) ctx.afterCommit(() => this.bus.publish('alert.created', streamView(alert)));
      }),

      on(LedgerEntriesPosted, async (envelope, ctx) => {
        const p = envelope.payload;
        const isNew = await this.alerts.recordAccountEvent(ctx.tx, {
          accountId: p.accountId,
          kind: 'LEDGER',
          transactionId: p.transactionId,
          occurredAt: p.postedAt,
          payload: p,
        });
        if (!isNew) return;
        // Balance of the customer account: credits minus debits, in integer cents.
        const mine = p.entries.filter((e) => e.ledgerAccount === `customer:${p.accountId}`);
        const first = mine[0];
        if (!first) return;
        const cents = mine.reduce(
          (sum, e) => sum + (e.direction === 'CREDIT' ? toCents(e.amount) : -toCents(e.amount)),
          0n,
        );
        await this.alerts.addToBalance(ctx.tx, p.accountId, first.currency, fromCents(cents));
      }),

      on(AccountProfileUpserted, async (envelope, ctx) => {
        await this.alerts.upsertProfile(ctx.tx, envelope.payload);
      }),
    ];
  }

  // ---- REST operations -----------------------------------------------------------------

  list(filter: AlertFilter): Promise<Alert[]> {
    return this.alerts.list(this.pool, filter);
  }

  /** Detail view, audited as ALERT_VIEWED in the same transaction as the read. */
  view(alertId: string, actor: Principal, ipHash: string): Promise<Alert> {
    return withTransaction(this.pool, async (tx) => {
      const alert = await this.alerts.get(tx, alertId);
      if (!alert) throw new AlertNotFoundError();
      await this.audit.record(tx, {
        actorId: actor.userId,
        action: 'ALERT_VIEWED',
        targetType: 'alert',
        targetId: alertId,
        ipHash,
      });
      return alert;
    });
  }

  async assign(alertId: string, actor: Principal, ipHash: string): Promise<Alert> {
    const alert = await withTransaction(this.pool, async (tx) => {
      const updated = await this.alerts.assign(tx, alertId, actor.userId);
      if (!updated) throw await this.missingOrResolved(tx, alertId);
      await this.audit.record(tx, {
        actorId: actor.userId,
        action: 'ALERT_ASSIGNED',
        targetType: 'alert',
        targetId: alertId,
        ipHash,
      });
      return updated;
    });
    this.bus.publish('alert.updated', streamView(alert));
    return alert;
  }

  /**
   * Alert update, audit entry and AnalystFeedbackRecorded (outbox) in one transaction: the
   * feedback reaches the anomaly scorer if and only if the resolution is stored (SPEC §6.8).
   */
  async resolve(
    alertId: string,
    actor: Principal,
    verdict: Verdict,
    note: string,
    ipHash: string,
  ): Promise<Alert> {
    const alert = await withTransaction(this.pool, async (tx) => {
      const resolved = await this.alerts.resolve(tx, alertId, actor.userId, verdict);
      if (!resolved) throw await this.missingOrResolved(tx, alertId);
      await this.audit.record(tx, {
        actorId: actor.userId,
        action: 'ALERT_RESOLVED',
        targetType: 'alert',
        targetId: alertId,
        metadata: { verdict, note },
        ipHash,
      });
      await this.outbox.write(tx, {
        topic: AnalystFeedbackRecorded.topic,
        key: resolved.accountId,
        envelope: createEnvelope({
          eventType: AnalystFeedbackRecorded.eventType,
          eventVersion: AnalystFeedbackRecorded.eventVersion,
          producer: PRODUCER,
          correlationId: resolved.transactionId,
          payload: toFeedbackEvent(resolved, verdict, actor.userId, note, new Date()),
        }),
      });
      return resolved;
    });
    this.bus.publish('alert.updated', streamView(alert));
    return alert;
  }

  timeline(accountId: string) {
    return this.alerts.timeline(this.pool, accountId);
  }

  account(accountId: string) {
    return this.alerts.account(this.pool, accountId);
  }

  async summary(windowSeconds: number): Promise<Summary> {
    return summarize(await this.alerts.decisionCounts(this.pool, windowSeconds), windowSeconds);
  }

  private async missingOrResolved(
    tx: Parameters<AlertsRepository['get']>[0],
    alertId: string,
  ): Promise<Error> {
    return (await this.alerts.get(tx, alertId))
      ? new AlertAlreadyResolvedError()
      : new AlertNotFoundError();
  }
}

/** Transaction (masked PAN only) + rule and score details, as the UI shows them. */
function snapshotOf(d: FraudDecisionMadeV1, transaction: Record<string, unknown>) {
  return {
    transaction,
    decision: {
      decision: d.decision,
      finalScore: d.finalScore,
      components: d.components,
      reasons: d.reasons,
      partial: d.partial,
      decidedAt: d.decidedAt,
      latencyMs: d.latencyMs,
      breakdown: d.breakdown ?? null,
    },
  };
}
