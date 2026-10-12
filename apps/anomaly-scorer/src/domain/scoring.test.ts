import { describe, expect, it } from 'vitest';
import { EPSILON, logistic } from './ewma.js';
import {
  MIN_BASELINE,
  revert,
  score,
  TIER_DEFAULTS,
  update,
  type Baseline,
  type Contribution,
  type Observation,
  type RiskTier,
} from './scoring.js';

const ALPHA = 0.1;
const t0 = Date.parse('2026-10-01T12:00:00Z');
const obs = (i: number, amount: number, hour = 12, newMerchant = false): Observation => ({
  amount,
  at: new Date(t0 + i * 6 * 3_600_000).toISOString(), // every 6 hours
  hour,
  newMerchant,
});

/** Independent, deliberately naive implementation of SPEC §6.5 for cross-checking. */
function reference(sequence: Observation[], tier: RiskTier) {
  let mA = 0,
    vA = 0,
    mI = TIER_DEFAULTS[tier].interArrival.mean,
    vI = TIER_DEFAULTS[tier].interArrival.variance;
  let last: number | null = null;
  const zs: { amountZ: number; interZ: number }[] = [];
  sequence.forEach((o, n) => {
    const x = Math.log(o.amount);
    const ia = last === null ? null : Math.log(Math.max(1, (Date.parse(o.at) - last) / 1000));
    const useOwn = n >= MIN_BASELINE;
    const refA = useOwn
      ? { m: mA, v: vA }
      : { m: TIER_DEFAULTS[tier].amount.mean, v: TIER_DEFAULTS[tier].amount.variance };
    const refI = useOwn
      ? { m: mI, v: vI }
      : { m: TIER_DEFAULTS[tier].interArrival.mean, v: TIER_DEFAULTS[tier].interArrival.variance };
    zs.push({
      amountZ: (x - refA.m) / Math.sqrt(refA.v + EPSILON),
      interZ: ia === null ? 0 : (ia - refI.m) / Math.sqrt(refI.v + EPSILON),
    });
    if (n === 0) {
      mA = x;
      vA = TIER_DEFAULTS[tier].amount.variance;
    } else {
      const d = x - mA;
      mA = ALPHA * x + (1 - ALPHA) * mA;
      vA = (1 - ALPHA) * (vA + ALPHA * d * d);
      if (ia !== null) {
        const di = ia - mI;
        mI = ALPHA * ia + (1 - ALPHA) * mI;
        vI = (1 - ALPHA) * (vI + ALPHA * di * di);
      }
    }
    last = Date.parse(o.at);
  });
  return { mA, vA, mI, vI, zs };
}

const fold = (sequence: Observation[], tier: RiskTier = 'MEDIUM') => {
  let b: Baseline | null = null;
  const scores = sequence.map((o) => {
    const s = score(b, tier, o);
    b = update(b, tier, o, ALPHA);
    return s;
  });
  return { baseline: b as Baseline | null, scores };
};

describe('EWMA scoring vs the reference implementation', () => {
  const amounts = [120, 95, 130, 110, 150, 80, 105, 140, 99, 125, 118, 2400, 101, 97, 133];
  const sequence = amounts.map((a, i) => obs(i, a));

  it('matches every z-score and the final statistics within 1e-9', () => {
    const { baseline, scores } = fold(sequence);
    const ref = reference(sequence, 'MEDIUM');
    scores.forEach((s, i) => {
      expect(Math.abs(s.features.amountZ - (ref.zs[i]?.amountZ ?? NaN))).toBeLessThan(1e-4 + 1e-9); // published rounded to 4 dp
    });
    expect(Math.abs((baseline?.amount.mean ?? 0) - ref.mA)).toBeLessThan(1e-9);
    expect(Math.abs((baseline?.amount.variance ?? 0) - ref.vA)).toBeLessThan(1e-9);
    expect(Math.abs((baseline?.interArrival.mean ?? 0) - ref.mI)).toBeLessThan(1e-9);
    expect(Math.abs((baseline?.interArrival.variance ?? 0) - ref.vI)).toBeLessThan(1e-9);
    expect(baseline?.n).toBe(amounts.length);
  });

  it('flags the 2400.00 spike once the baseline is trusted', () => {
    const { scores } = fold(sequence);
    const spike = scores[11];
    expect(spike?.coldStart).toBe(false);
    expect(spike?.features.amountZ).toBeGreaterThan(4);
    expect(spike?.anomalyScore).toBeGreaterThan(0.5);
    expect(scores[12]?.anomalyScore).toBeLessThan(0.3);
  });
});

describe('cold start (n < 10)', () => {
  it('scores against the risk-tier defaults and reports the real sample size', () => {
    const first = score(null, 'LOW', obs(0, 80));
    expect(first).toMatchObject({ baselineSampleSize: 0, coldStart: true });
    expect(Math.abs(first.features.amountZ)).toBeLessThan(1e-3); // 80.00 is the LOW typical ticket
    expect(first.features.interArrivalZ).toBe(0);
    expect(first.features.hourOfDayDeviation).toBe(0);

    const high = score(null, 'HIGH', obs(0, 80));
    expect(high.features.amountZ).toBeLessThan(first.features.amountZ); // same ticket is smaller for HIGH
  });

  it('switches to the own baseline at 10 transactions', () => {
    const { scores } = fold(Array.from({ length: 11 }, (_, i) => obs(i, 100)));
    expect(scores[9]).toMatchObject({ baselineSampleSize: 9, coldStart: true });
    expect(scores[10]).toMatchObject({ baselineSampleSize: 10, coldStart: false });
  });
});

describe('features', () => {
  it('measures hour-of-day deviation and new merchants', () => {
    const { baseline } = fold(Array.from({ length: 12 }, (_, i) => obs(i, 100, 14)));
    const s = score(baseline, 'MEDIUM', obs(12, 100, 3, true));
    expect(s.features.hourOfDayDeviation).toBe(1); // never seen at 03:00
    expect(s.features.newMerchant).toBe(true);
    const { amountZ, interArrivalZ } = s.features;
    const raw = 0.5 * Math.max(0, amountZ) + 0.2 * Math.max(0, -interArrivalZ) + 0.2 + 0.1;
    expect(s.anomalyScore).toBeCloseTo(logistic(raw), 3);
  });

  it('treats a burst (short interval) as anomalous inter-arrival', () => {
    const { baseline } = fold(Array.from({ length: 12 }, (_, i) => obs(i, 100)));
    const burst = score(baseline, 'MEDIUM', {
      amount: 100,
      at: new Date(t0 + 11 * 6 * 3_600_000 + 5000).toISOString(),
      hour: 12,
      newMerchant: false,
    });
    expect(burst.features.interArrivalZ).toBeLessThan(-3);
  });
});

describe('revert (analyst-confirmed fraud)', () => {
  it('gives exactly the baseline computed without the fraudulent transaction', () => {
    const sequence = [100, 110, 95, 5000, 105, 120, 99].map((a, i) => obs(i, a));
    const contributions: Contribution[] = [];
    let b: Baseline | null = null;
    sequence.forEach((o, i) => {
      contributions.push({ transactionId: `t${i}`, prior: b, tier: 'MEDIUM', observation: o });
      b = update(b, 'MEDIUM', o, ALPHA);
    });

    const result = revert(contributions, 't3', ALPHA);
    const expected = fold(sequence.filter((_, i) => i !== 3)).baseline;
    expect(result?.baseline).toEqual(expected);
    expect(result?.rewritten.map((c) => c.transactionId)).toEqual(['t4', 't5', 't6']);
    expect(revert(contributions, 'unknown', ALPHA)).toBeNull();
  });
});
