import type { Random } from './random.js';
import { normalTransaction, type PlannedTransaction } from './traffic.js';
import type { Account, World } from './world.js';

/** Relative purchase intensity by local hour: busy days, quiet nights. */
const HOUR_WEIGHTS = [
  1, 0.5, 0.3, 0.2, 0.2, 0.4, 1, 3, 5, 6, 7, 8, 9, 8, 7, 7, 7, 8, 9, 9, 8, 6, 4, 2,
] as const;
const HOUR_TOTAL = HOUR_WEIGHTS.reduce((s, w) => s + w, 0);
/** Brazil's representative zone (America/Sao_Paulo) is UTC-3 all year. */
const BRAZIL_UTC_OFFSET_HOURS = -3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface HistoricalTransaction {
  at: Date;
  tx: PlannedTransaction;
}

export interface HistoryOptions {
  days: number;
  /** History ends here; live traffic follows it. */
  end: Date;
}

/**
 * The account's past normal traffic in time order: a Poisson number of purchases per day
 * (mean `dailyRate`) at local hours drawn from a day/night profile. It builds the 30-day
 * baselines of fraud-rules and anomaly-scorer before live traffic starts (SPEC §6.9).
 */
export function accountHistory(
  random: Random,
  world: World,
  account: Account,
  options: HistoryOptions,
): HistoricalTransaction[] {
  const history: HistoricalTransaction[] = [];
  // Whole UTC days, so the hour offset below lands on the intended local hour.
  const start = Math.floor((options.end.getTime() - options.days * DAY_MS) / DAY_MS) * DAY_MS;
  for (let day = 0; day <= options.days; day++) {
    const dayStart = start + day * DAY_MS;
    for (let n = poisson(random, account.dailyRate); n > 0; n--) {
      const at = dayStart + localHourToUtcOffsetMs(pickHour(random)) + random.int(0, 3_599_999);
      if (at < options.end.getTime()) {
        history.push({ at: new Date(at), tx: normalTransaction(random, world, account) });
      }
    }
  }
  return history.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function pickHour(random: Random): number {
  let r = random.next() * HOUR_TOTAL;
  for (const [hour, weight] of HOUR_WEIGHTS.entries()) {
    r -= weight;
    if (r < 0) return hour;
  }
  return 12;
}

function localHourToUtcOffsetMs(localHour: number): number {
  return ((((localHour - BRAZIL_UTC_OFFSET_HOURS) % 24) + 24) % 24) * 60 * 60 * 1000;
}

/** Knuth's algorithm; fine for the small daily means used here. */
function poisson(random: Random, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = random.next();
  while (p > limit) {
    k++;
    p *= random.next();
  }
  return k;
}
