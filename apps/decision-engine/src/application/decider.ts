import {
  AnomalyScored,
  FraudDecisionMade,
  FraudRulesEvaluated,
  type AnomalyScoredV1,
  type Envelope,
  type FraudDecisionMadeV1,
  type FraudRulesEvaluatedV1,
} from '@fraudstream/contracts';
import { withTransaction, type Pool, type PoolClient } from '@fraudstream/db';
import { childEnvelope, on, type EventHandler } from '@fraudstream/kafka';
import { Counter, Histogram, type Registry } from '@fraudstream/observability';
import type { OutboxWriter } from '@fraudstream/outbox';
import { configVersion, decide, type FusionConfig, type Outcome } from '../domain/fusion.js';

export const PRODUCER = 'decision-engine';

interface StoredPart<P> {
  envelope: Envelope<P>;
  traceparent: string;
}

interface PendingRow {
  transaction_id: string;
  account_id: string;
  rule_result: StoredPart<FraudRulesEvaluatedV1> | null;
  anomaly_score: StoredPart<AnomalyScoredV1> | null;
}

const UPSERT_RULES = `
  INSERT INTO pending (transaction_id, account_id, rule_result, deadline_at)
  VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')
  ON CONFLICT (transaction_id) DO UPDATE SET rule_result = EXCLUDED.rule_result
  RETURNING transaction_id, account_id, rule_result, anomaly_score`;
const UPSERT_SCORE = `
  INSERT INTO pending (transaction_id, account_id, anomaly_score, deadline_at)
  VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')
  ON CONFLICT (transaction_id) DO UPDATE SET anomaly_score = EXCLUDED.anomaly_score
  RETURNING transaction_id, account_id, rule_result, anomaly_score`;

/** Builds the published decision; exported for contract tests (SPEC §13.3). */
export function toDecisionEvent(
  transactionId: string,
  accountId: string,
  outcome: Outcome,
  decidedAt: Date,
  requestedAt: string | undefined,
): FraudDecisionMadeV1 {
  return {
    transactionId,
    accountId,
    decision: outcome.decision,
    finalScore: outcome.finalScore,
    components: outcome.components,
    reasons: outcome.reasons,
    partial: outcome.partial,
    decidedAt: decidedAt.toISOString(),
    latencyMs: requestedAt ? Math.max(0, decidedAt.getTime() - Date.parse(requestedAt)) : 0,
  };
}

/**
 * The join of SPEC §6.6, persisted in `decision.pending`: each part is upserted; the first
 * moment both are present (or the deadline passes, see `sweep`) the decision is written,
 * the pending row deleted and the event put in the outbox, in one transaction.
 * `decisions.transaction_id` is the primary key, so a late or duplicate part can never
 * produce a second decision.
 */
export class Decider {
  readonly version: string;
  private readonly decisions: Counter<'decision'>;
  private readonly latency: Histogram;

  constructor(
    private readonly cfg: FusionConfig & { joinTimeoutMs: number },
    private readonly outbox: OutboxWriter,
    registry: Registry,
  ) {
    this.version = configVersion(cfg);
    this.decisions = new Counter({
      name: 'decisions_total',
      help: 'Fraud decisions by outcome',
      labelNames: ['decision'],
      registers: [registry],
    });
    this.latency = new Histogram({
      name: 'decision_latency_seconds',
      help: 'Time from authorization request to decision',
      buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 3, 5],
      registers: [registry],
    });
  }

  handlers(): EventHandler[] {
    return [
      on(FraudRulesEvaluated, (envelope, ctx) =>
        this.receive(ctx.tx, UPSERT_RULES, envelope, ctx.traceparent),
      ),
      on(AnomalyScored, (envelope, ctx) =>
        this.receive(ctx.tx, UPSERT_SCORE, envelope, ctx.traceparent),
      ),
    ];
  }

  private async receive(
    tx: PoolClient,
    upsertSql: string,
    envelope: Envelope<FraudRulesEvaluatedV1> | Envelope<AnomalyScoredV1>,
    traceparent: string,
  ): Promise<void> {
    const { transactionId, accountId } = envelope.payload;
    const decided = await tx.query('SELECT 1 FROM decisions WHERE transaction_id = $1', [
      transactionId,
    ]);
    if (decided.rowCount) return; // late part after a partial decision: ignored
    const part: StoredPart<unknown> = { envelope, traceparent };
    const { rows } = await tx.query<PendingRow>(upsertSql, [
      transactionId,
      accountId,
      JSON.stringify(part),
      this.cfg.joinTimeoutMs,
    ]);
    const row = rows[0];
    if (row?.rule_result && row.anomaly_score) await this.finalize(tx, row, part);
  }

  /** Timeout sweeper (every 250 ms): decides whatever is past its deadline with what it has. */
  async sweep(pool: Pool, limit = 100): Promise<number> {
    return withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<PendingRow>(
        `SELECT transaction_id, account_id, rule_result, anomaly_score FROM pending
          WHERE deadline_at < now() ORDER BY deadline_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      for (const row of rows) {
        const cause = row.rule_result ?? row.anomaly_score;
        if (cause) await this.finalize(tx, row, cause);
      }
      return rows.length;
    });
  }

  private async finalize(
    tx: PoolClient,
    row: PendingRow,
    cause: StoredPart<unknown>,
  ): Promise<void> {
    const rules = row.rule_result?.envelope.payload ?? null;
    const score = row.anomaly_score?.envelope.payload ?? null;
    const outcome = decide(rules, score, this.cfg);
    const decidedAt = new Date();
    const event = toDecisionEvent(
      row.transaction_id,
      row.account_id,
      outcome,
      decidedAt,
      rules?.requestedAt ?? score?.requestedAt,
    );
    await tx.query('DELETE FROM pending WHERE transaction_id = $1', [row.transaction_id]);
    const inserted = await tx.query(
      `INSERT INTO decisions (transaction_id, account_id, decision, final_score, rule_score, anomaly_score,
                              partial, reasons, config_version, latency_ms, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (transaction_id) DO NOTHING`,
      [
        row.transaction_id,
        row.account_id,
        outcome.decision,
        outcome.finalScore,
        outcome.components.ruleScore,
        outcome.components.anomalyScore,
        outcome.partial,
        outcome.reasons,
        this.version,
        event.latencyMs,
        decidedAt,
      ],
    );
    if (inserted.rowCount !== 1) return; // already decided
    await this.outbox.write(tx, {
      topic: FraudDecisionMade.topic,
      key: row.account_id,
      envelope: childEnvelope(cause.envelope, {
        eventType: FraudDecisionMade.eventType,
        eventVersion: FraudDecisionMade.eventVersion,
        producer: PRODUCER,
        payload: event,
      }),
      traceparent: cause.traceparent,
    });
    this.decisions.inc({ decision: outcome.decision });
    this.latency.observe(event.latencyMs / 1000);
  }
}
