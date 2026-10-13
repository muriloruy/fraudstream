import type {
  FraudDecisionMadeV1,
  LedgerEntriesPostedV1,
  TransactionAuthorizationRequestedV1,
} from '@fraudstream/contracts';
import type { Pool, PoolClient } from '@fraudstream/db';
import type { QueueCursor } from '../../domain/cursor.js';
import { latencyBucketsFor, type DecisionCounts } from '../../domain/stats.js';

type Db = Pick<PoolClient, 'query'>;

export const ALERT_STATUSES = ['OPEN', 'IN_PROGRESS', 'CONFIRMED_FRAUD', 'LEGITIMATE'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const OPEN_STATUSES: readonly AlertStatus[] = ['OPEN', 'IN_PROGRESS'];
export type Verdict = 'CONFIRMED_FRAUD' | 'LEGITIMATE';

export interface Alert {
  alertId: string;
  transactionId: string;
  accountId: string;
  decision: 'REVIEW' | 'DECLINE';
  finalScore: string;
  reasons: string[];
  snapshot: Record<string, unknown>;
  status: AlertStatus;
  assignedTo: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const ALERT_COLUMNS = `alert_id AS "alertId", transaction_id AS "transactionId", account_id AS "accountId",
  decision, final_score::text AS "finalScore", reasons, snapshot, status, assigned_to AS "assignedTo",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "resolvedAt"`;

export interface AlertFilter {
  statuses: readonly AlertStatus[];
  minScore?: string;
  accountId?: string;
  after?: QueueCursor;
  limit: number;
}

const INSERT_ALERT = `INSERT INTO alerts.alerts (alert_id, transaction_id, account_id, decision,
    final_score, reasons, snapshot, status, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', now())
  ON CONFLICT (transaction_id) DO NOTHING
  RETURNING ${ALERT_COLUMNS}`;
const SELECT_ALERT = `SELECT ${ALERT_COLUMNS} FROM alerts.alerts WHERE alert_id = $1`;
const ASSIGN_ALERT = `UPDATE alerts.alerts SET assigned_to = $2, status = 'IN_PROGRESS'
  WHERE alert_id = $1 AND status IN ('OPEN','IN_PROGRESS')
  RETURNING ${ALERT_COLUMNS}`;
const RESOLVE_ALERT = `UPDATE alerts.alerts
    SET status = $3, assigned_to = COALESCE(assigned_to, $2), resolved_at = now()
  WHERE alert_id = $1 AND status IN ('OPEN','IN_PROGRESS')
  RETURNING ${ALERT_COLUMNS}`;

/**
 * Builds a parameterized statement from constant SQL fragments: values only ever travel as
 * `$n` parameters, never inside the SQL text (SPEC §7).
 */
class Sql {
  readonly parts: string[] = [];
  readonly values: unknown[] = [];

  add(fragment: string, ...values: unknown[]): this {
    let text = fragment;
    for (const value of values) {
      this.values.push(value);
      text = text.replace('?', `$${String(this.values.length)}`);
    }
    this.parts.push(text);
    return this;
  }

  get text(): string {
    return this.parts.join(' ');
  }
}

export class AlertsRepository {
  // ---- projections (consumer side) ----------------------------------------------------------

  async rememberTransaction(db: Db, p: TransactionAuthorizationRequestedV1): Promise<void> {
    // Masked PAN only: the token, device and IP hashes are not needed by analysts.
    const details = {
      amount: p.amount,
      merchant: p.merchant,
      maskedPan: p.maskedPan,
      channel: p.channel,
      entryMode: p.entryMode,
      ...(p.geo ? { geo: p.geo } : {}),
      requestedAt: p.requestedAt,
    };
    await db.query(
      `INSERT INTO alerts.transactions_seen (transaction_id, account_id, details, requested_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (transaction_id) DO NOTHING`,
      [p.transactionId, p.accountId, JSON.stringify(details), p.requestedAt],
    );
  }

  async transactionDetails(db: Db, transactionId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await db.query<{ details: Record<string, unknown> }>(
      'SELECT details FROM alerts.transactions_seen WHERE transaction_id = $1',
      [transactionId],
    );
    return rows[0]?.details ?? null;
  }

  /** Null when the transaction already has an alert (duplicate or replayed decision). */
  async createAlert(
    db: Db,
    d: FraudDecisionMadeV1 & { decision: 'REVIEW' | 'DECLINE' },
    alertId: string,
    snapshot: Record<string, unknown>,
  ): Promise<Alert | null> {
    const { rows } = await db.query<Alert>(INSERT_ALERT, [
      alertId,
      d.transactionId,
      d.accountId,
      d.decision,
      d.finalScore,
      d.reasons,
      JSON.stringify(snapshot),
    ]);
    return rows[0] ?? null;
  }

  /** True when the event was new; the account keeps its last 100 events only. */
  async recordAccountEvent(
    db: Db,
    e: {
      accountId: string;
      kind: 'DECISION' | 'LEDGER';
      transactionId: string;
      occurredAt: string;
      payload: unknown;
    },
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `INSERT INTO alerts.account_events (account_id, kind, transaction_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (kind, transaction_id) DO NOTHING`,
      [e.accountId, e.kind, e.transactionId, e.occurredAt, JSON.stringify(e.payload)],
    );
    if (!rowCount) return false;
    await db.query(
      `DELETE FROM alerts.account_events WHERE id IN (
         SELECT id FROM alerts.account_events WHERE account_id = $1
          ORDER BY occurred_at DESC, id DESC OFFSET 100)`,
      [e.accountId],
    );
    return true;
  }

  async countDecision(db: Db, d: FraudDecisionMadeV1): Promise<void> {
    const one = (decision: string) => (d.decision === decision ? 1 : 0);
    await db.query(
      `INSERT INTO alerts.decision_stats AS s (bucket, approve, review, decline, latency_buckets)
       VALUES (date_trunc('second', $1::timestamptz), $2, $3, $4, $5)
       ON CONFLICT (bucket) DO UPDATE SET
         approve = s.approve + EXCLUDED.approve,
         review = s.review + EXCLUDED.review,
         decline = s.decline + EXCLUDED.decline,
         latency_buckets = ARRAY(SELECT a + b FROM unnest(s.latency_buckets, EXCLUDED.latency_buckets) AS t(a, b))`,
      [d.decidedAt, one('APPROVE'), one('REVIEW'), one('DECLINE'), latencyBucketsFor(d.latencyMs)],
    );
  }

  async purge(pool: Pool, retentionMs: number): Promise<void> {
    await pool.query(
      "DELETE FROM alerts.transactions_seen WHERE recorded_at < now() - $1 * interval '1 millisecond'",
      [retentionMs],
    );
    await pool.query("DELETE FROM alerts.decision_stats WHERE bucket < now() - interval '2 days'");
  }

  // ---- queries (REST side) ---------------------------------------------------------------

  /**
   * Keyset page ordered by final_score DESC, created_at, alert_id. The order mixes directions,
   * so "after the cursor" is spelled out instead of a row comparison:
   *   score < s OR (score = s AND (created_at, alert_id) > (c, a)).
   * With the default open statuses the predicate matches the partial index alerts_queue_idx.
   */
  async list(db: Db, f: AlertFilter): Promise<Alert[]> {
    const q = new Sql().add(`SELECT ${ALERT_COLUMNS} FROM alerts.alerts WHERE`);
    const onlyOpen = f.statuses.every((s) => OPEN_STATUSES.includes(s));
    q.add(
      onlyOpen
        ? "status IN ('OPEN','IN_PROGRESS') AND status = ANY(?::text[])"
        : 'status = ANY(?::text[])',
      [...f.statuses],
    );
    if (f.minScore !== undefined) q.add('AND final_score >= ?::numeric', f.minScore);
    if (f.accountId !== undefined) q.add('AND account_id = ?', f.accountId);
    if (f.after) {
      q.add(
        'AND (final_score < ?::numeric OR (final_score = ?::numeric AND (created_at, alert_id) > (?::timestamptz, ?::uuid)))',
        f.after.finalScore,
        f.after.finalScore,
        f.after.createdAt,
        f.after.alertId,
      );
    }
    q.add('ORDER BY final_score DESC, created_at, alert_id LIMIT ?', f.limit);
    return (await db.query<Alert>(q.text, q.values)).rows;
  }

  async get(db: Db, alertId: string): Promise<Alert | null> {
    const { rows } = await db.query<Alert>(SELECT_ALERT, [alertId]);
    return rows[0] ?? null;
  }

  /** Assign to self: only open alerts; returns null when resolved or unknown. */
  async assign(db: Db, alertId: string, userId: string): Promise<Alert | null> {
    const { rows } = await db.query<Alert>(ASSIGN_ALERT, [alertId, userId]);
    return rows[0] ?? null;
  }

  /** Optimistic resolution: only an open alert can be resolved (a second resolve gets null → 409). */
  async resolve(db: Db, alertId: string, userId: string, verdict: Verdict): Promise<Alert | null> {
    const { rows } = await db.query<Alert>(RESOLVE_ALERT, [alertId, userId, verdict]);
    return rows[0] ?? null;
  }

  async timeline(db: Db, accountId: string) {
    const { rows } = await db.query<{
      kind: 'DECISION' | 'LEDGER';
      transactionId: string;
      occurredAt: string;
      payload: FraudDecisionMadeV1 | LedgerEntriesPostedV1;
    }>(
      `SELECT kind, transaction_id AS "transactionId",
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", payload
         FROM alerts.account_events WHERE account_id = $1
        ORDER BY occurred_at DESC, id DESC LIMIT 100`,
      [accountId],
    );
    return rows;
  }

  async decisionCounts(db: Db, windowSeconds: number): Promise<DecisionCounts> {
    const { rows } = await db.query<{
      approve: number;
      review: number;
      decline: number;
      latency: number[] | null;
    }>(
      `SELECT coalesce(sum(approve), 0)::int AS approve, coalesce(sum(review), 0)::int AS review,
              coalesce(sum(decline), 0)::int AS decline,
              (SELECT array_agg(total ORDER BY i) FROM (
                 SELECT i, sum(c)::int AS total
                   FROM alerts.decision_stats, unnest(latency_buckets) WITH ORDINALITY AS u(c, i)
                  WHERE bucket >= now() - $1 * interval '1 second'
                  GROUP BY i) t) AS latency
         FROM alerts.decision_stats WHERE bucket >= now() - $1 * interval '1 second'`,
      [windowSeconds],
    );
    const r = rows[0];
    return {
      approve: r?.approve ?? 0,
      review: r?.review ?? 0,
      decline: r?.decline ?? 0,
      latencyBuckets: r?.latency ?? latencyBucketsFor(0).map(() => 0),
    };
  }
}
