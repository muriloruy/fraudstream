import { describe, expect, it } from 'vitest';
import {
  configVersion,
  decide,
  DEFAULT_FUSION,
  type FusionConfig,
  type RulePart,
  type ScorePart,
} from './fusion.js';

const cfg: FusionConfig = { approveBelow: 0.4, declineFrom: 0.75, ...DEFAULT_FUSION };
const rules = (ruleScore: number, hardDecline = false, fired: string[] = []): RulePart => ({
  ruleScore,
  hardDecline,
  firedRules: fired.map((id) => ({ ruleId: id, name: `rule_${id}` })),
});
const score = (
  anomalyScore: number,
  baselineSampleSize = 50,
  over: Partial<ScorePart['features']> = {},
): ScorePart => ({
  anomalyScore,
  baselineSampleSize,
  features: { amountZ: 0, interArrivalZ: 0, newMerchant: false, hourOfDayDeviation: 0, ...over },
});

describe('decide (SPEC §6.6)', () => {
  // With a trusted baseline, rule = anomaly = s gives finalScore = s exactly.
  it.each([
    [0.3999, 'APPROVE'],
    [0.4, 'REVIEW'],
    [0.7499, 'REVIEW'],
    [0.75, 'DECLINE'],
  ] as const)('finalScore %s -> %s', (s, expected) => {
    const outcome = decide(rules(s), score(s), cfg);
    expect(outcome.finalScore).toBe(s);
    expect(outcome.decision).toBe(expected);
    expect(outcome.partial).toBe(false);
  });

  it('weights the anomaly score 0.4 with a trusted baseline and 0.15 during cold start', () => {
    expect(decide(rules(0.5), score(1, 10), cfg).finalScore).toBe(0.7); // 0.6*0.5 + 0.4*1
    expect(decide(rules(0.5), score(1, 9), cfg).finalScore).toBe(0.575); // 0.85*0.5 + 0.15*1
  });

  it('declines on a hard-decline rule whatever the score', () => {
    const outcome = decide(rules(0.1, true, ['R006']), score(0.1), cfg);
    expect(outcome).toMatchObject({
      decision: 'DECLINE',
      finalScore: 0.1,
      reasons: ['card testing: several small purchases within minutes (R006)'],
    });
  });

  it('decides on the rules alone when the anomaly score timed out', () => {
    expect(decide(rules(0.3), null, cfg)).toMatchObject({
      decision: 'APPROVE',
      finalScore: 0.3,
      partial: true,
      components: { ruleScore: 0.3, anomalyScore: null },
      reasons: ['anomaly score unavailable (timeout)'],
    });
  });

  it('always reviews when the rule result is missing', () => {
    expect(decide(null, score(0.05), cfg)).toMatchObject({
      decision: 'REVIEW',
      partial: true,
      finalScore: 0.05,
    });
    expect(() => decide(null, null, cfg)).toThrow();
  });

  it('keeps unknown rules readable by id and name', () => {
    expect(decide(rules(0.2, false, ['R999']), score(0.1), cfg).reasons).toEqual([
      'R999 rule_R999',
    ]);
  });

  it('explains rules and anomalies in plain language (SPEC §9.3)', () => {
    const outcome = decide(
      rules(0.3, false, ['R001']),
      score(0.81, 143, {
        amountZ: 4.2,
        interArrivalZ: -3.5,
        newMerchant: true,
        hourOfDayDeviation: 0.95,
      }),
      cfg,
    );
    expect(outcome.reasons).toEqual([
      'many transactions in the last minute (R001)',
      'amount 4.2σ above baseline',
      'transactions much closer together than usual',
      'unusual time of day for this account',
      'first purchase at this merchant',
    ]);
  });
});

describe('configVersion', () => {
  it('changes with any threshold or weight', () => {
    expect(configVersion(cfg)).toMatch(/^fusion-[0-9a-f]{12}$/);
    expect(configVersion(cfg)).toBe(configVersion({ ...cfg }));
    expect(configVersion({ ...cfg, declineFrom: 0.8 })).not.toBe(configVersion(cfg));
  });
});

describe('effective weights (score breakdown)', () => {
  const cfg = { ...DEFAULT_FUSION, approveBelow: 0.4, declineFrom: 0.75 };
  const rules = { ruleScore: 0.5, hardDecline: false, firedRules: [] };
  const score = (n: number) => ({
    anomalyScore: 0.5,
    baselineSampleSize: n,
    features: { amountZ: 0, interArrivalZ: 0, newMerchant: false, hourOfDayDeviation: 0 },
  });

  it('reports the weights applied to each part', () => {
    expect(decide(rules, score(50), cfg).weights).toEqual({ rules: 0.6, anomaly: 0.4 });
    expect(decide(rules, score(3), cfg).weights).toEqual({ rules: 0.85, anomaly: 0.15 });
    expect(decide(rules, null, cfg).weights).toEqual({ rules: 1, anomaly: 0 });
    expect(decide(null, score(50), cfg).weights).toEqual({ rules: 0, anomaly: 1 });
  });
});
