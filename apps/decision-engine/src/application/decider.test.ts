import { describe, expect, it } from 'vitest';
import { isLiveLatency, LIVE_LATENCY_LIMIT_MS, toDecisionEvent } from './decider.js';

describe('decision latency metric', () => {
  const outcome = {
    decision: 'APPROVE' as const,
    finalScore: 0.1,
    components: { ruleScore: 0.1, anomalyScore: 0.1 },
    reasons: [],
    partial: false,
    weights: { rules: 0.6, anomaly: 0.4 },
  };

  it('observes live decisions and leaves backfill (seed history, DLQ replays) out', () => {
    const decidedAt = new Date('2026-10-17T12:00:00Z');
    const live = toDecisionEvent('t1', 'a1', outcome, decidedAt, '2026-10-17T11:59:59.700Z');
    const seeded = toDecisionEvent('t2', 'a1', outcome, decidedAt, '2026-09-20T09:00:00Z');
    expect(live.latencyMs).toBe(300);
    expect(isLiveLatency(live.latencyMs)).toBe(true);
    expect(isLiveLatency(seeded.latencyMs)).toBe(false);
    // A 100k backlog drains in under 2 minutes (SPEC §11): still observed.
    expect(isLiveLatency(2 * 60 * 1000)).toBe(true);
    expect(isLiveLatency(LIVE_LATENCY_LIMIT_MS)).toBe(false);
  });
});
