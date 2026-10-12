import { createHash } from 'node:crypto';

export type Decision = 'APPROVE' | 'REVIEW' | 'DECLINE';

export interface FusionConfig {
  approveBelow: number; // finalScore < approveBelow -> APPROVE
  declineFrom: number; // finalScore >= declineFrom -> DECLINE
  anomalyWeight: number; // weight of a trusted anomaly score
  coldStartAnomalyWeight: number; // weight while the account baseline is young
  minBaseline: number; // sample size from which the anomaly score is trusted
}

export const DEFAULT_FUSION: Omit<FusionConfig, 'approveBelow' | 'declineFrom'> = {
  anomalyWeight: 0.4,
  coldStartAnomalyWeight: 0.15,
  minBaseline: 10,
};

export interface RulePart {
  ruleScore: number;
  hardDecline: boolean;
  firedRules: readonly { ruleId: string; name: string }[];
}

export interface ScorePart {
  anomalyScore: number;
  baselineSampleSize: number;
  features: {
    amountZ: number;
    interArrivalZ: number;
    newMerchant: boolean;
    hourOfDayDeviation: number;
  };
}

export interface Outcome {
  decision: Decision;
  finalScore: number;
  components: { ruleScore: number | null; anomalyScore: number | null };
  reasons: string[];
  partial: boolean;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Plain-language reasons shown to analysts (SPEC §9.3). */
export function anomalyReasons(s: ScorePart, minBaseline: number): string[] {
  const reasons: string[] = [];
  const f = s.features;
  if (f.amountZ >= 3) reasons.push(`amount ${f.amountZ.toFixed(1)}σ above baseline`);
  if (f.interArrivalZ <= -3) reasons.push('transactions much closer together than usual');
  if (s.baselineSampleSize >= minBaseline && f.hourOfDayDeviation >= 0.9) {
    reasons.push('unusual time of day for this account');
  }
  if (f.newMerchant && s.anomalyScore >= 0.5) reasons.push('first purchase at this merchant');
  return reasons;
}

/**
 * Fusion of rule and anomaly scores (SPEC §6.6):
 *   wAnomaly = 0.4 if baselineSampleSize >= 10 else 0.15;  finalScore = wRules·rule + wAnomaly·anomaly
 *   hardDecline -> DECLINE;  < approveBelow -> APPROVE;  < declineFrom -> REVIEW;  else DECLINE
 * With only one part (join timeout) the decision is partial; without the rule result it is
 * always REVIEW.
 */
export function decide(
  rules: RulePart | null,
  score: ScorePart | null,
  cfg: FusionConfig,
): Outcome {
  if (!rules && !score) throw new Error('nothing to decide on');
  const reasons = [
    ...(rules?.firedRules.map((r) => `${r.ruleId} ${r.name}`) ?? []),
    ...(score ? anomalyReasons(score, cfg.minBaseline) : []),
  ];
  const components = {
    ruleScore: rules?.ruleScore ?? null,
    anomalyScore: score?.anomalyScore ?? null,
  };

  if (!rules) {
    return {
      decision: 'REVIEW',
      finalScore: round4(score?.anomalyScore ?? 0),
      components,
      reasons: [...reasons, 'rule evaluation unavailable (timeout)'],
      partial: true,
    };
  }

  let finalScore = rules.ruleScore;
  if (score) {
    const wAnomaly =
      score.baselineSampleSize >= cfg.minBaseline ? cfg.anomalyWeight : cfg.coldStartAnomalyWeight;
    finalScore = (1 - wAnomaly) * rules.ruleScore + wAnomaly * score.anomalyScore;
  } else {
    reasons.push('anomaly score unavailable (timeout)');
  }
  finalScore = round4(finalScore);

  const decision: Decision = rules.hardDecline
    ? 'DECLINE'
    : finalScore < cfg.approveBelow
      ? 'APPROVE'
      : finalScore < cfg.declineFrom
        ? 'REVIEW'
        : 'DECLINE';
  return { decision, finalScore, components, reasons, partial: !score };
}

/** Short hash of the thresholds and weights, stored with every decision for auditability. */
export function configVersion(cfg: FusionConfig): string {
  const canonical = JSON.stringify([
    cfg.approveBelow,
    cfg.declineFrom,
    cfg.anomalyWeight,
    cfg.coldStartAnomalyWeight,
    cfg.minBaseline,
  ]);
  return `fusion-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}
