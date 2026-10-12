import { ewmaUpdate, logistic, zScore, type Stat } from './ewma.js';

export const MODEL_VERSION = 'ewma-1.0';
/** Below this many transactions the account's own baseline is not trusted (cold start). */
export const MIN_BASELINE = 10;

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

/** Per-account state, persisted in anomaly.account_baselines. */
export interface Baseline {
  n: number;
  amount: Stat; // on ln(amount)
  interArrival: Stat; // on ln(seconds since previous transaction)
  hourHistogram: number[]; // 24 buckets, merchant local time
  lastTxAt: string | null; // ISO
}

/** One transaction as the model sees it. */
export interface Observation {
  amount: number; // major units; only its logarithm is used, so float precision is irrelevant
  at: string; // ISO
  hour: number; // 0-23, merchant local time
  newMerchant: boolean;
}

export interface Features {
  amountZ: number;
  interArrivalZ: number;
  newMerchant: boolean;
  hourOfDayDeviation: number;
}

export interface Score {
  anomalyScore: number;
  features: Features;
  baselineSampleSize: number;
  coldStart: boolean;
}

/**
 * Population defaults per risk tier, used for cold start (n < 10) and as the starting
 * baseline of new accounts. Typical ticket and purchase frequency grow with the tier.
 */
export const TIER_DEFAULTS: Record<RiskTier, { amount: Stat; interArrival: Stat }> = {
  LOW: {
    amount: { mean: Math.log(80), variance: 0.6 },
    interArrival: { mean: Math.log(2 * 86_400), variance: 1.5 },
  },
  MEDIUM: {
    amount: { mean: Math.log(150), variance: 0.8 },
    interArrival: { mean: Math.log(86_400), variance: 1.5 },
  },
  HIGH: {
    amount: { mean: Math.log(300), variance: 1.2 },
    interArrival: { mean: Math.log(43_200), variance: 2 },
  },
};

const secondsBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** ln(seconds since the previous transaction), at least 1 s; null for the first one. */
export function logInterArrival(baseline: Baseline | null, at: string): number | null {
  if (!baseline?.lastTxAt) return null;
  return Math.log(Math.max(1, secondsBetween(baseline.lastTxAt, at)));
}

/** Scores a transaction against the baseline BEFORE it (SPEC §6.5). */
export function score(baseline: Baseline | null, tier: RiskTier, obs: Observation): Score {
  const n = baseline?.n ?? 0;
  const coldStart = n < MIN_BASELINE;
  // eslint-disable-next-line security/detect-object-injection -- `tier` is a typed enum value
  const reference = coldStart || !baseline ? TIER_DEFAULTS[tier] : baseline;

  const amountZ = zScore(Math.log(obs.amount), reference.amount);
  const ia = logInterArrival(baseline, obs.at);
  const interArrivalZ = ia === null ? 0 : zScore(ia, reference.interArrival);
  const max = baseline ? Math.max(...baseline.hourHistogram) : 0;
  const hourOfDayDeviation =
    coldStart || !baseline || max === 0 ? 0 : 1 - (baseline.hourHistogram[obs.hour] ?? 0) / max;

  const raw =
    0.5 * Math.max(0, amountZ) +
    0.2 * Math.max(0, -interArrivalZ) +
    0.2 * hourOfDayDeviation +
    0.1 * (obs.newMerchant ? 1 : 0);

  return {
    anomalyScore: round4(logistic(raw)),
    features: {
      amountZ: round4(amountZ),
      interArrivalZ: round4(interArrivalZ),
      newMerchant: obs.newMerchant,
      hourOfDayDeviation: round4(hourOfDayDeviation),
    },
    baselineSampleSize: n,
    coldStart,
  };
}

/** Folds a transaction into the baseline (after scoring). */
export function update(
  baseline: Baseline | null,
  tier: RiskTier,
  obs: Observation,
  alpha: number,
): Baseline {
  const x = Math.log(obs.amount);
  const hist = baseline ? [...baseline.hourHistogram] : Array.from({ length: 24 }, () => 0);
  hist[obs.hour] = (hist[obs.hour] ?? 0) + 1;
  if (!baseline) {
    // eslint-disable-next-line security/detect-object-injection -- `tier` is a typed enum value
    const d = TIER_DEFAULTS[tier];
    return {
      n: 1,
      amount: { mean: x, variance: d.amount.variance },
      interArrival: { ...d.interArrival },
      hourHistogram: hist,
      lastTxAt: obs.at,
    };
  }
  const ia = logInterArrival(baseline, obs.at);
  const lastTxAt = baseline.lastTxAt && baseline.lastTxAt > obs.at ? baseline.lastTxAt : obs.at;
  return {
    n: baseline.n + 1,
    amount: ewmaUpdate(baseline.amount, x, alpha),
    interArrival:
      ia === null ? baseline.interArrival : ewmaUpdate(baseline.interArrival, ia, alpha),
    hourHistogram: hist,
    lastTxAt,
  };
}

export interface Contribution {
  transactionId: string;
  prior: Baseline | null;
  tier: RiskTier;
  observation: Observation;
}

/**
 * Removes one transaction's contribution exactly: restart from the baseline before it and
 * re-apply every later contribution (SPEC §6.5, analyst-confirmed fraud). Returns the new
 * baseline and the later contributions with their corrected priors.
 */
export function revert(
  contributions: readonly Contribution[],
  transactionId: string,
  alpha: number,
): { baseline: Baseline | null; rewritten: Contribution[] } | null {
  const index = contributions.findIndex((c) => c.transactionId === transactionId);
  const target = contributions.at(index);
  if (index < 0 || !target) return null;
  let state = target.prior;
  const rewritten: Contribution[] = [];
  for (const c of contributions.slice(index + 1)) {
    rewritten.push({ ...c, prior: state });
    state = update(state, c.tier, c.observation, alpha);
  }
  return { baseline: state, rewritten };
}
