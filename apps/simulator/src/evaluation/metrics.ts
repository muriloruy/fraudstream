import { isScenario, SCENARIOS, type Scenario } from '../domain/traffic.js';

export type Decision = 'APPROVE' | 'REVIEW' | 'DECLINE';

export interface GroundTruth {
  transactionId: string;
  isFraud: boolean;
  scenario: Scenario;
}

/** Parses `simulator_output/ground_truth.csv` (header `transactionId,isFraud,scenario,...`). */
export function parseGroundTruth(csv: string): GroundTruth[] {
  const [header, ...lines] = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const columns = (header ?? '').split(',');
  const id = columns.indexOf('transactionId');
  const fraud = columns.indexOf('isFraud');
  const scenarioAt = columns.indexOf('scenario');
  if (id < 0 || fraud < 0 || scenarioAt < 0) throw new Error('ground truth: unexpected header');
  return lines.map((line, n) => {
    const cells = line.split(',');
    const scenario = cells.at(scenarioAt) ?? '';
    if (!isScenario(scenario)) throw new Error(`ground truth line ${n + 2}: bad scenario`);
    return { transactionId: cells.at(id) ?? '', isFraud: cells.at(fraud) === 'true', scenario };
  });
}

export interface ScenarioMetrics {
  scenario: Scenario | 'all fraud';
  transactions: number;
  decided: number;
  /** In the ground truth but without a decision yet: not counted as negatives (M7 spec). */
  undecided: number;
  reviews: number;
  declines: number;
  /** Flagged = REVIEW or DECLINE (SPEC §9.1). */
  flagged: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  reviewRate: number | null;
  declineRate: number | null;
  /** Only for `normal`: flagged / decided (SPEC §9.2 target ≤ 3%). */
  falsePositiveRate: number | null;
}

export interface EvaluationReport {
  rows: ScenarioMetrics[];
  undecided: GroundTruth[];
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/**
 * SPEC §9.1 per scenario. A transaction is predicted positive when flagged (REVIEW or
 * DECLINE). Per fraud scenario, precision is that of a stream where this scenario is the
 * only fraud: its true positives against every flagged normal transaction. The `all fraud`
 * row is the detector's actual precision and recall on the run.
 */
export function evaluate(
  truth: readonly GroundTruth[],
  decisions: ReadonlyMap<string, Decision>,
): EvaluationReport {
  const undecided = truth.filter((t) => !decisions.has(t.transactionId));
  const tally = (rows: readonly GroundTruth[]) => {
    const decided = rows.filter((t) => decisions.has(t.transactionId));
    const reviews = decided.filter((t) => decisions.get(t.transactionId) === 'REVIEW').length;
    const declines = decided.filter((t) => decisions.get(t.transactionId) === 'DECLINE').length;
    return { transactions: rows.length, decided: decided.length, reviews, declines };
  };

  const normal = tally(truth.filter((t) => !t.isFraud));
  const falsePositives = normal.reviews + normal.declines;
  const fraudRow = (scenario: ScenarioMetrics['scenario'], rows: readonly GroundTruth[]) => {
    const t = tally(rows);
    const flagged = t.reviews + t.declines;
    const precision = ratio(flagged, flagged + falsePositives);
    const recall = ratio(flagged, t.decided);
    return {
      scenario,
      ...t,
      undecided: t.transactions - t.decided,
      flagged,
      precision,
      recall,
      f1:
        precision !== null && recall !== null && precision + recall > 0
          ? (2 * precision * recall) / (precision + recall)
          : null,
      reviewRate: ratio(t.reviews, t.decided),
      declineRate: ratio(t.declines, t.decided),
      falsePositiveRate: null,
    } satisfies ScenarioMetrics;
  };

  const rows: ScenarioMetrics[] = [
    {
      scenario: 'normal',
      ...normal,
      undecided: normal.transactions - normal.decided,
      flagged: falsePositives,
      precision: null,
      recall: null,
      f1: null,
      reviewRate: ratio(normal.reviews, normal.decided),
      declineRate: ratio(normal.declines, normal.decided),
      falsePositiveRate: ratio(falsePositives, normal.decided),
    },
    ...SCENARIOS.filter((s) => s !== 'normal').map((scenario) =>
      fraudRow(
        scenario,
        truth.filter((t) => t.isFraud && t.scenario === scenario),
      ),
    ),
    fraudRow(
      'all fraud',
      truth.filter((t) => t.isFraud),
    ),
  ];
  return { rows, undecided };
}

export interface TargetCheck {
  label: string;
  value: number | null;
  target: string;
  met: boolean;
}

/** SPEC §9.2 targets on simulator data. */
export function checkTargets(report: EvaluationReport): TargetCheck[] {
  const row = (s: ScenarioMetrics['scenario']) => report.rows.find((r) => r.scenario === s);
  const atLeast = (label: string, value: number | null | undefined, min: number): TargetCheck => ({
    label,
    value: value ?? null,
    target: `≥ ${min.toFixed(2)}`,
    met: value !== null && value !== undefined && value >= min,
  });
  const fpr = row('normal')?.falsePositiveRate ?? null;
  return [
    atLeast('recall card_testing', row('card_testing')?.recall, 0.9),
    atLeast('recall impossible_travel', row('impossible_travel')?.recall, 0.9),
    atLeast('recall account_takeover', row('account_takeover')?.recall, 0.7),
    {
      label: 'false positive rate normal',
      value: fpr,
      target: '≤ 3.0%',
      met: fpr !== null && fpr <= 0.03,
    },
  ];
}

export interface ReasonShare {
  reason: string;
  /** Share of the scenario's flagged transactions that carry this reason. */
  share: number;
}

/**
 * The most frequent decision reasons per scenario among flagged transactions, to review that
 * each attack is explained in plain language (SPEC §9.3). Anomaly reasons embed numbers
 * ("amount 4.2σ above baseline"), so digits are generalized before counting.
 */
export function topReasons(
  truth: readonly GroundTruth[],
  decisions: ReadonlyMap<string, { decision: Decision; reasons: readonly string[] }>,
  limit = 3,
): Map<Scenario, ReasonShare[]> {
  const result = new Map<Scenario, ReasonShare[]>();
  for (const scenario of SCENARIOS) {
    const flagged = truth
      .filter((t) => t.scenario === scenario)
      .map((t) => decisions.get(t.transactionId))
      .filter((d) => d !== undefined && d.decision !== 'APPROVE');
    if (flagged.length === 0) continue;
    const counts = new Map<string, number>();
    for (const d of flagged) {
      for (const reason of new Set(d?.reasons.map((r) => r.replace(/\d+\.\d+/g, 'N')))) {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
    }
    result.set(
      scenario,
      [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([reason, n]) => ({ reason, share: n / flagged.length })),
    );
  }
  return result;
}

export interface ReportMeta {
  title: string;
  /** e.g. model, ruleset and decision config versions, run parameters. */
  details: readonly string[];
  reasons?: ReadonlyMap<Scenario, readonly ReasonShare[]>;
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const dec = (x: number | null) => (x === null ? '—' : x.toFixed(3));

/** The Markdown section `pnpm eval` prints and appends to docs/model.md. */
export function toMarkdown(report: EvaluationReport, meta: ReportMeta): string {
  const lines = [
    `### ${meta.title}`,
    '',
    ...meta.details.map((d) => `- ${d}`),
    '',
    '| Scenario | Transactions | Decided | Precision | Recall | F1 | Review rate | Decline rate | FP rate |',
    '| --- | --: | --: | --: | --: | --: | --: | --: | --: |',
    ...report.rows.map(
      (r) =>
        `| ${r.scenario} | ${r.transactions} | ${r.decided} | ${dec(r.precision)} | ${dec(r.recall)} | ` +
        `${dec(r.f1)} | ${pct(r.reviewRate)} | ${pct(r.declineRate)} | ${pct(r.falsePositiveRate)} |`,
    ),
    '',
    'Targets (SPEC §9.2):',
    '',
    ...checkTargets(report).map(
      (t) =>
        `- ${t.met ? '✅' : '❌'} ${t.label}: ${t.label.startsWith('false') ? pct(t.value) : dec(t.value)} (target ${t.target})`,
    ),
  ];
  if (meta.reasons && meta.reasons.size > 0) {
    lines.push('', 'Top reasons of flagged transactions (SPEC §9.3):', '');
    lines.push('| Scenario | Reasons (share of flagged) |', '| --- | --- |');
    for (const [scenario, shares] of meta.reasons) {
      const text = shares.map((s) => `${s.reason} (${pct(s.share)})`).join('; ');
      lines.push(`| ${scenario} | ${text} |`);
    }
  }
  if (report.undecided.length > 0) {
    const shown = report.undecided
      .slice(0, 10)
      .map((u) => `\`${u.transactionId}\` (${u.scenario})`);
    lines.push(
      '',
      `Undecided (no decision yet, excluded from the rates): ${report.undecided.length}` +
        `${report.undecided.length > 10 ? ', first 10' : ''}: ${shown.join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
