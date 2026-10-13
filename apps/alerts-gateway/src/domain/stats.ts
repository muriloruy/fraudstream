/** Upper bounds (ms) of the decision latency histogram; the last bucket is +Inf. */
export const LATENCY_BUCKETS_MS = [50, 100, 200, 300, 500, 750, 1000, 2000, 3000, 5000] as const;

/** One-hot histogram row for a single decision latency. */
export function latencyBucketsFor(latencyMs: number): number[] {
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => latencyMs <= bound);
  const counts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  counts[index === -1 ? LATENCY_BUCKETS_MS.length : index] = 1;
  return counts;
}

/**
 * Quantile estimated from bucket counts by linear interpolation inside the bucket, as
 * Prometheus' histogram_quantile does. Returns null without data; the +Inf bucket reports the
 * largest finite bound.
 */
export function quantileMs(counts: readonly number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = q * total;
  let seen = 0;
  for (const [i, count] of counts.entries()) {
    if (seen + count >= rank && count > 0) {
      const upper = LATENCY_BUCKETS_MS.at(i);
      if (upper === undefined) return LATENCY_BUCKETS_MS.at(-1) ?? null;
      const lower = i === 0 ? 0 : (LATENCY_BUCKETS_MS.at(i - 1) ?? 0);
      return Math.round(lower + ((upper - lower) * (rank - seen)) / count);
    }
    seen += count;
  }
  return LATENCY_BUCKETS_MS.at(-1) ?? null;
}

export interface DecisionCounts {
  approve: number;
  review: number;
  decline: number;
  latencyBuckets: readonly number[];
}

export interface Summary {
  windowSeconds: number;
  decisions: number;
  transactionsPerSecond: number;
  rates: { approve: number; review: number; decline: number };
  p95LatencyMs: number | null;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** SPEC §6.8 `/v1/metrics/summary`: every transaction gets exactly one decision. */
export function summarize(c: DecisionCounts, windowSeconds: number): Summary {
  const decisions = c.approve + c.review + c.decline;
  const rate = (n: number) => (decisions === 0 ? 0 : round4(n / decisions));
  return {
    windowSeconds,
    decisions,
    transactionsPerSecond: round4(decisions / windowSeconds),
    rates: { approve: rate(c.approve), review: rate(c.review), decline: rate(c.decline) },
    p95LatencyMs: quantileMs(c.latencyBuckets, 0.95),
  };
}

/** `15m`, `1h`, `30s` windows for the summary, bounded to a day. */
export function parseWindowSeconds(value: string): number | null {
  const match = /^(\d{1,4})([smh])$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}
