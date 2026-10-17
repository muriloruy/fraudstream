import { randomUUID } from 'node:crypto';
import type { PlannedTransaction, Scenario } from '../domain/traffic.js';

/** `POST /v1/transactions` body (SPEC §6.1) for a planned transaction. */
export function requestBody(tx: PlannedTransaction) {
  return {
    accountId: tx.account.accountId,
    card: { ...tx.account.card },
    amount: { value: tx.amount, currency: 'BRL' },
    merchant: {
      id: tx.merchant.id,
      name: tx.merchant.name,
      mcc: tx.merchant.mcc,
      country: tx.merchant.city.country,
      city: tx.merchant.city.name,
    },
    channel: tx.channel,
    entryMode: tx.entryMode,
    device: { ip: tx.ip, deviceId: tx.deviceId },
    geo: tx.geo,
  };
}

export interface SendResult {
  status: number;
  transactionId?: string;
}

/** Sends one authorization; the simulator gives each request its own Idempotency-Key. */
export type Sender = (
  body: ReturnType<typeof requestBody>,
  idempotencyKey: string,
) => Promise<SendResult>;

export function httpSender(apiUrl: string, apiKey: string): Sender {
  return async (body, idempotencyKey) => {
    const res = await fetch(`${apiUrl}/v1/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (res.status !== 202) {
      await res.body?.cancel();
      return { status: res.status };
    }
    const { transactionId } = (await res.json()) as { transactionId: string };
    return { status: res.status, transactionId };
  };
}

export interface GroundTruthRow {
  transactionId: string;
  isFraud: boolean;
  scenario: Scenario;
  accountId: string;
}

export interface RunOptions {
  tps: number;
  plan: readonly PlannedTransaction[];
  send: Sender;
  /** Called after each 202, with the label of the accepted transaction. */
  onAccepted: (row: GroundTruthRow) => void;
  /** Requests allowed in flight at once; past it the run falls behind and says so. */
  maxInFlight?: number;
  onProgress?: (stats: RunStats) => void;
}

export interface RunStats {
  planned: number;
  sent: number;
  accepted: number;
  /** Non-202 responses by status (0 = network error). */
  rejected: Record<string, number>;
  elapsedMs: number;
  /** Time the scheduler had to wait for a free in-flight slot. */
  maxLagMs: number;
}

const TICK_MS = 5;

/**
 * Sends the plan at `tps` (SPEC §6.9 `sim:run`): request `i` is due at `i / tps` s after the
 * start, so the rate holds without bursts or drift. Responses are awaited concurrently.
 */
export async function runTraffic(options: RunOptions): Promise<RunStats> {
  const { plan, tps } = options;
  const maxInFlight = options.maxInFlight ?? 512;
  const stats: RunStats = {
    planned: plan.length,
    sent: 0,
    accepted: 0,
    rejected: {},
    elapsedMs: 0,
    maxLagMs: 0,
  };
  const inFlight = new Set<Promise<void>>();
  const start = performance.now();
  let lastProgress = start;
  let next = 0;

  const fire = (tx: PlannedTransaction) => {
    stats.sent++;
    const work = options
      .send(requestBody(tx), randomUUID())
      .then(
        (result) => {
          if (result.status === 202 && result.transactionId) {
            stats.accepted++;
            options.onAccepted({
              transactionId: result.transactionId,
              isFraud: tx.isFraud,
              scenario: tx.scenario,
              accountId: tx.account.accountId,
            });
          } else {
            stats.rejected[result.status] = (stats.rejected[result.status] ?? 0) + 1;
          }
        },
        () => {
          stats.rejected['0'] = (stats.rejected['0'] ?? 0) + 1;
        },
      )
      .finally(() => inFlight.delete(work));
    inFlight.add(work);
  };

  while (next < plan.length) {
    const now = performance.now();
    const due = Math.min(plan.length, Math.floor(((now - start) * tps) / 1000) + 1);
    while (next < due && inFlight.size < maxInFlight) {
      const tx = plan.at(next);
      if (tx) fire(tx);
      next++;
    }
    if (next < due) stats.maxLagMs = Math.max(stats.maxLagMs, now - (start + (next * 1000) / tps));
    if (options.onProgress && now - lastProgress >= 5000) {
      lastProgress = now;
      options.onProgress({ ...stats, elapsedMs: now - start });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  await Promise.allSettled([...inFlight]);
  stats.elapsedMs = performance.now() - start;
  return stats;
}

/** `simulator_output/ground_truth.csv` row (SPEC §6.9); ids and labels need no quoting. */
export const GROUND_TRUTH_HEADER = 'transactionId,isFraud,scenario,accountId';

export function groundTruthLine(row: GroundTruthRow): string {
  return `${row.transactionId},${row.isFraud},${row.scenario},${row.accountId}`;
}
