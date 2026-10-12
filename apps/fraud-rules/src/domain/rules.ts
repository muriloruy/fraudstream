import { localHour, toCents } from '@fraudstream/contracts';
import type { Ruleset } from './ruleset.js';

/** The transaction being evaluated, reduced to what the rules need. Amounts in cents. */
export interface TransactionFacts {
  transactionId: string;
  accountId: string;
  amountCents: bigint;
  merchantId: string;
  mcc: string;
  country: string;
  bin: string;
  requestedAt: Date;
  geo?: { lat: number; lon: number } | undefined;
}

/** Per-account state loaded in one query before evaluation (SPEC §6.4). Excludes this transaction. */
export interface RuleContext {
  countInVelocityWindow: number; // R001 window
  sumInAmountWindowCents: bigint; // R002 window
  smallInTestingWindow: number; // R006 window, amounts below the small threshold
  historyCount: number; // R003/R009 history window
  historySumCents: bigint;
  last: { country: string; lat: number | null; lon: number | null; at: Date } | null;
  knownMerchant: boolean;
  blocklistHits: string[]; // e.g. ['MCC:7995']
  profile: { homeCountry: string; creditLimitCents: bigint } | null;
}

export interface RuleHit {
  ruleId: string;
  name: string;
  points: number;
  hardDecline: boolean;
  details: Record<string, unknown>;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km (haversine). */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const cents = (c: bigint) => `${(c / 100n).toString()}.${(c % 100n).toString().padStart(2, '0')}`;

type Rule = (tx: TransactionFacts, ctx: RuleContext, ruleset: Ruleset) => RuleHit | null;

function hit(
  ruleset: Ruleset,
  id: keyof Ruleset['rules'],
  details: Record<string, unknown>,
): RuleHit {
  // `id` is a typed key of the ruleset, never user input.
  // eslint-disable-next-line security/detect-object-injection
  const rule = ruleset.rules[id];
  return {
    ruleId: id,
    name: rule.name,
    points: rule.points,
    hardDecline: rule.hardDecline,
    details,
  };
}

/** Pure rule functions, R001-R010 (SPEC §6.4). Each returns a hit or null. */
export const RULES: Record<keyof Ruleset['rules'], Rule> = {
  R001: (_tx, ctx, rs) => {
    const count = ctx.countInVelocityWindow + 1;
    const { maxTransactions, windowSeconds } = rs.rules.R001;
    return count > maxTransactions
      ? hit(rs, 'R001', { [`countLast${windowSeconds}s`]: count, threshold: maxTransactions })
      : null;
  },

  R002: (tx, ctx, rs) => {
    const limit = ctx.profile?.creditLimitCents ?? rs.defaultCreditLimitCents;
    const sum = ctx.sumInAmountWindowCents + tx.amountCents;
    const share = rs.rules.R002.creditLimitShare;
    // sum > share * limit, in integer arithmetic (share has at most 4 decimals).
    const fires = sum * 10_000n > limit * BigInt(Math.round(share * 10_000));
    return fires
      ? hit(rs, 'R002', { sumLastHour: cents(sum), creditLimit: cents(limit), share })
      : null;
  },

  R003: (tx, ctx, rs) => {
    const { minHistory, multiplier } = rs.rules.R003;
    if (ctx.historyCount < minHistory) return null;
    // amount > multiplier * (sum / count)  <=>  amount * count > multiplier * sum
    const fires =
      tx.amountCents * BigInt(ctx.historyCount) * 100n >
      BigInt(Math.round(multiplier * 100)) * ctx.historySumCents;
    return fires
      ? hit(rs, 'R003', {
          amount: cents(tx.amountCents),
          average: cents(ctx.historySumCents / BigInt(ctx.historyCount)),
          multiplier,
        })
      : null;
  },

  R004: (tx, ctx, rs) => {
    const last = ctx.last;
    if (!last || !tx.geo || last.lat === null || last.lon === null || last.country === tx.country)
      return null;
    const km = haversineKm({ lat: last.lat, lon: last.lon }, tx.geo);
    const hours = Math.max(0, tx.requestedAt.getTime() - last.at.getTime()) / 3_600_000;
    const speed = hours === 0 ? Number.POSITIVE_INFINITY : km / hours;
    return speed > rs.rules.R004.maxSpeedKmh
      ? hit(rs, 'R004', {
          fromCountry: last.country,
          toCountry: tx.country,
          distanceKm: Math.round(km),
          speedKmh: Number.isFinite(speed) ? Math.round(speed) : null,
        })
      : null;
  },

  R005: (tx, ctx, rs) =>
    ctx.profile && ctx.profile.homeCountry !== tx.country
      ? hit(rs, 'R005', { homeCountry: ctx.profile.homeCountry, merchantCountry: tx.country })
      : null,

  R006: (tx, ctx, rs) => {
    const { smallAmount, minTransactions } = rs.rules.R006;
    const count = ctx.smallInTestingWindow + (tx.amountCents < toCents(smallAmount) ? 1 : 0);
    return count >= minTransactions
      ? hit(rs, 'R006', {
          smallTransactions: count,
          below: smallAmount,
          threshold: minTransactions,
        })
      : null;
  },

  R007: (tx, ctx, rs) =>
    !ctx.knownMerchant && tx.amountCents > toCents(rs.rules.R007.amount)
      ? hit(rs, 'R007', {
          merchantId: tx.merchantId,
          amount: cents(tx.amountCents),
          threshold: rs.rules.R007.amount,
        })
      : null,

  R008: (_tx, ctx, rs) =>
    ctx.blocklistHits.length > 0 ? hit(rs, 'R008', { matches: ctx.blocklistHits }) : null,

  R009: (tx, ctx, rs) => {
    const { fromHour, toHour, multiplier } = rs.rules.R009;
    if (ctx.historyCount === 0) return null;
    const hour = localHour(tx.country, tx.requestedAt);
    if (hour < fromHour || hour >= toHour) return null;
    const fires =
      tx.amountCents * BigInt(ctx.historyCount) * 100n >
      BigInt(Math.round(multiplier * 100)) * ctx.historySumCents;
    return fires
      ? hit(rs, 'R009', { localHour: hour, amount: cents(tx.amountCents), multiplier })
      : null;
  },

  R010: (tx, ctx, rs) => {
    // Available credit approximated as limit minus 30-day spend: the ledger (M4) is the
    // source of truth for balances and is not consulted on the scoring path.
    const limit = ctx.profile?.creditLimitCents ?? rs.defaultCreditLimitCents;
    const available = limit - ctx.historySumCents;
    return tx.amountCents > available
      ? hit(rs, 'R010', {
          amount: cents(tx.amountCents),
          availableCredit: cents(available > 0n ? available : 0n),
        })
      : null;
  },
};

export interface Evaluation {
  ruleScore: number;
  hardDecline: boolean;
  firedRules: RuleHit[];
}

/** Runs every rule; `ruleScore = min(1, sum(points) / 100)` (SPEC §6.4). */
export function evaluate(tx: TransactionFacts, ctx: RuleContext, ruleset: Ruleset): Evaluation {
  const firedRules = Object.values(RULES)
    .map((rule) => rule(tx, ctx, ruleset))
    .filter((h): h is RuleHit => h !== null);
  const points = firedRules.reduce((sum, h) => sum + h.points, 0);
  return {
    ruleScore: Math.min(1, points / 100),
    hardDecline: firedRules.some((h) => h.hardDecline),
    firedRules,
  };
}
