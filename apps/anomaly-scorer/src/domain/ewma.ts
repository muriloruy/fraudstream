/**
 * Exponentially weighted statistics (SPEC §6.5), with α the weight of the newest value:
 *   mean_t = α·x + (1−α)·mean_{t−1}
 *   var_t  = (1−α)·(var_{t−1} + α·(x − mean_{t−1})²)
 *   z      = (x − mean_{t−1}) / sqrt(var_{t−1} + ε)
 * z is always computed against the statistics BEFORE the current value.
 */
export const EPSILON = 1e-6;

export interface Stat {
  mean: number;
  variance: number;
}

export function zScore(x: number, prior: Stat): number {
  return (x - prior.mean) / Math.sqrt(prior.variance + EPSILON);
}

export function ewmaUpdate(prior: Stat, x: number, alpha: number): Stat {
  const delta = x - prior.mean;
  return {
    mean: alpha * x + (1 - alpha) * prior.mean,
    variance: (1 - alpha) * (prior.variance + alpha * delta * delta),
  };
}

/** Logistic squashing centred at raw = 2 (SPEC §6.5). */
export function logistic(raw: number, centre = 2): number {
  return 1 / (1 + Math.exp(-(raw - centre)));
}
