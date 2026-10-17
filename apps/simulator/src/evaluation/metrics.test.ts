import { describe, expect, it } from 'vitest';
import type { Scenario } from '../domain/traffic.js';
import {
  checkTargets,
  evaluate,
  parseGroundTruth,
  toMarkdown,
  type Decision,
  type GroundTruth,
} from './metrics.js';

/** Builds `count` labeled transactions of one scenario with a given decision mix. */
function cohort(
  scenario: Scenario,
  isFraud: boolean,
  mix: Partial<Record<Decision | 'none', number>>,
): { truth: GroundTruth[]; decisions: [string, Decision][] } {
  const truth: GroundTruth[] = [];
  const decisions: [string, Decision][] = [];
  for (const [decision, count] of Object.entries(mix)) {
    for (let i = 0; i < count; i++) {
      const transactionId = `${scenario}-${decision}-${i}`;
      truth.push({ transactionId, isFraud, scenario });
      if (decision !== 'none') decisions.push([transactionId, decision as Decision]);
    }
  }
  return { truth, decisions };
}

function fixture() {
  const parts = [
    // 1000 normal: 970 approved, 20 reviewed, 10 declined -> FP rate 3.0%
    cohort('normal', false, { APPROVE: 970, REVIEW: 20, DECLINE: 10 }),
    // card testing: 90 flagged of 100 decided, plus 5 still undecided
    cohort('card_testing', true, { DECLINE: 80, REVIEW: 10, APPROVE: 10, none: 5 }),
    cohort('account_takeover', true, { REVIEW: 14, APPROVE: 6 }),
    cohort('impossible_travel', true, { REVIEW: 9, APPROVE: 1 }),
  ];
  return {
    truth: parts.flatMap((p) => p.truth),
    decisions: new Map(parts.flatMap((p) => p.decisions)),
  };
}

describe('evaluate (SPEC §9.1)', () => {
  it('computes the rates on a fixed confusion matrix', () => {
    const { truth, decisions } = fixture();
    const report = evaluate(truth, decisions);
    const row = (s: string) => report.rows.find((r) => r.scenario === s);

    expect(row('normal')).toMatchObject({
      transactions: 1000,
      decided: 1000,
      flagged: 30,
      falsePositiveRate: 0.03,
      reviewRate: 0.02,
      declineRate: 0.01,
      precision: null,
      recall: null,
    });

    // TP = 90 of 100 decided; FP = 30 normal -> precision 90/120 = 0.75, recall 0.9
    const ct = row('card_testing');
    expect(ct).toMatchObject({ transactions: 105, decided: 100, undecided: 5, flagged: 90 });
    expect(ct?.recall).toBeCloseTo(0.9, 10);
    expect(ct?.precision).toBeCloseTo(0.75, 10);
    expect(ct?.f1).toBeCloseTo((2 * 0.75 * 0.9) / (0.75 + 0.9), 10);
    expect(ct?.declineRate).toBeCloseTo(0.8, 10);

    expect(row('account_takeover')?.recall).toBeCloseTo(0.7, 10);
    expect(row('merchant_compromise')).toMatchObject({ transactions: 0, recall: null, f1: null });

    // All fraud: TP = 90 + 14 + 9 = 113 of 130 decided; precision 113 / (113 + 30)
    const all = row('all fraud');
    expect(all?.recall).toBeCloseTo(113 / 130, 10);
    expect(all?.precision).toBeCloseTo(113 / 143, 10);
  });

  it('lists undecided transactions instead of counting them as negatives', () => {
    const { truth, decisions } = fixture();
    const report = evaluate(truth, decisions);
    expect(report.undecided).toHaveLength(5);
    expect(report.undecided.every((u) => u.scenario === 'card_testing')).toBe(true);
    // Recall over decided ones only: 90/100, not 90/105.
    expect(report.rows.find((r) => r.scenario === 'card_testing')?.recall).toBeCloseTo(0.9, 10);
  });

  it('checks the SPEC §9.2 targets, inclusive at the boundary', () => {
    const { truth, decisions } = fixture();
    expect(checkTargets(evaluate(truth, decisions)).map((t) => [t.label, t.met])).toEqual([
      ['recall card_testing', true],
      ['recall impossible_travel', true],
      ['recall account_takeover', true],
      ['false positive rate normal', true],
    ]);
    decisions.set('normal-APPROVE-0', 'REVIEW'); // 31 of 1000 -> 3.1%
    const fpr = checkTargets(evaluate(truth, decisions)).at(-1);
    expect(fpr?.met).toBe(false);
  });

  it('renders a Markdown table with one row per scenario and the target checks', () => {
    const { truth, decisions } = fixture();
    const md = toMarkdown(evaluate(truth, decisions), {
      title: 'Run 1',
      details: ['model `ewma-1.0`'],
    });
    expect(md).toContain('### Run 1');
    expect(md).toContain('| normal | 1000 | 1000 | — | — | — | 2.0% | 1.0% | 3.0% |');
    expect(md).toContain('| card_testing | 105 | 100 | 0.750 | 0.900 |');
    expect(md).toContain('✅ false positive rate normal: 3.0% (target ≤ 3.0%)');
    expect(md).toContain('Undecided (no decision yet, excluded from the rates): 5');
  });
});

describe('parseGroundTruth', () => {
  it('reads the simulator CSV', () => {
    const csv =
      'transactionId,isFraud,scenario,accountId\n' +
      'a,true,card_testing,acc_1\r\n' +
      'b,false,normal,acc_2\n';
    expect(parseGroundTruth(csv)).toEqual([
      { transactionId: 'a', isFraud: true, scenario: 'card_testing' },
      { transactionId: 'b', isFraud: false, scenario: 'normal' },
    ]);
    expect(() => parseGroundTruth('id,label\n')).toThrow(/header/);
    expect(() => parseGroundTruth('transactionId,isFraud,scenario\nx,true,heist\n')).toThrow(
      /bad scenario/,
    );
  });
});
