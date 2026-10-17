import { localHour, toCents } from '@fraudstream/contracts';
import { describe, expect, it } from 'vitest';
import { accountHistory } from './history.js';
import { Random } from './random.js';
import {
  accountTakeover,
  cardTesting,
  FRAUD_SCENARIOS,
  impossibleTravel,
  merchantCompromise,
  normalTransaction,
  planRun,
  type PlannedTransaction,
} from './traffic.js';
import { buildWorld, LISBON, medianCents } from './world.js';

const world = buildWorld(42, 200);
const cents = (tx: PlannedTransaction) => Number(toCents(tx.amount));

/** Haversine distance in km. */
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

describe('scenario generators (SPEC §6.9)', () => {
  it('normal: home city, own device, mostly favorite merchants, not fraud', () => {
    const random = new Random(1);
    const [account] = world.accounts;
    if (!account) throw new Error('no account');
    const txs = Array.from({ length: 2000 }, () => normalTransaction(random, world, account));
    const favorites = new Set(account.favorites.map((m) => m.id));
    const atFavorites = txs.filter((t) => favorites.has(t.merchant.id)).length / txs.length;
    expect(atFavorites).toBeGreaterThan(0.8);
    for (const tx of txs) {
      expect(tx).toMatchObject({ isFraud: false, scenario: 'normal', deviceId: account.deviceId });
      expect(tx.merchant.city).toBe(account.homeCity);
    }
  });

  it('card_testing: one card, 5-10 transactions of R$ 1-4 within minutes', () => {
    const random = new Random(2);
    for (let i = 0; i < 200; i++) {
      const burst = cardTesting(random, world);
      expect(burst.length).toBeGreaterThanOrEqual(5);
      expect(burst.length).toBeLessThanOrEqual(10);
      expect(new Set(burst.map((b) => b.tx.account.accountId)).size).toBe(1);
      expect(burst.at(-1)?.offsetSeconds ?? 0).toBeLessThan(5 * 60);
      for (const { tx } of burst) {
        expect(cents(tx)).toBeGreaterThanOrEqual(100);
        expect(cents(tx)).toBeLessThanOrEqual(400);
        expect(tx).toMatchObject({ isFraud: true, scenario: 'card_testing' });
      }
    }
  });

  it('account_takeover: high amounts at new merchants from a new device', () => {
    const random = new Random(3);
    for (let i = 0; i < 200; i++) {
      const attack = accountTakeover(random, world);
      const account = attack[0]?.tx.account;
      if (!account) throw new Error('empty attack');
      const favorites = new Set(account.favorites.map((m) => m.id));
      for (const { tx } of attack) {
        expect(favorites.has(tx.merchant.id)).toBe(false);
        expect(tx.deviceId).not.toBe(account.deviceId);
        expect(cents(tx)).toBeGreaterThanOrEqual(8 * medianCents(account) - 1);
        expect(tx).toMatchObject({ isFraud: true, scenario: 'account_takeover' });
      }
    }
  });

  it('impossible_travel: home, then Lisbon 30 minutes later (only Lisbon is fraud)', () => {
    const random = new Random(4);
    for (let i = 0; i < 200; i++) {
      const [home, abroad] = impossibleTravel(random, world);
      if (!home || !abroad) throw new Error('expected two transactions');
      expect(home.tx).toMatchObject({ isFraud: false, scenario: 'normal' });
      expect(abroad.tx).toMatchObject({ isFraud: true, scenario: 'impossible_travel' });
      expect(abroad.tx.merchant.city).toBe(LISBON);
      expect(abroad.offsetSeconds - home.offsetSeconds).toBe(30 * 60);
      const kmh = distanceKm(home.tx.geo, abroad.tx.geo) / 0.5;
      expect(kmh).toBeGreaterThan(900); // SPEC §6.4 R004
    }
  });

  it('merchant_compromise: many accounts, one merchant, abnormal amounts', () => {
    const random = new Random(5);
    for (let i = 0; i < 100; i++) {
      const attack = merchantCompromise(random, world);
      expect(attack.length).toBeGreaterThanOrEqual(8);
      expect(new Set(attack.map((a) => a.tx.merchant.id)).size).toBe(1);
      expect(new Set(attack.map((a) => a.tx.account.accountId)).size).toBe(attack.length);
      for (const { tx } of attack) {
        expect(cents(tx)).toBeGreaterThanOrEqual(4 * medianCents(tx.account) - 1);
        expect(tx).toMatchObject({ isFraud: true, scenario: 'merchant_compromise' });
      }
    }
  });
});

describe('planRun', () => {
  it('plans exactly tps x duration transactions with about the requested fraud rate', () => {
    const plan = planRun(new Random(6), world, { tps: 100, durationSeconds: 300, fraudRate: 0.02 });
    expect(plan).toHaveLength(30_000);
    const fraud = plan.filter((t) => t.isFraud);
    expect(fraud.length / plan.length).toBeGreaterThan(0.018);
    expect(fraud.length / plan.length).toBeLessThan(0.025);
    expect(new Set(fraud.map((t) => t.scenario))).toEqual(new Set(FRAUD_SCENARIOS));
  });

  it('injects only the chosen scenario, or none for normal', () => {
    const random = new Random(7);
    const only = planRun(random, world, {
      tps: 50,
      durationSeconds: 120,
      fraudRate: 0.05,
      scenario: 'card_testing',
    });
    expect(new Set(only.map((t) => t.scenario))).toEqual(new Set(['normal', 'card_testing']));
    const none = planRun(random, world, {
      tps: 50,
      durationSeconds: 60,
      fraudRate: 0.05,
      scenario: 'normal',
    });
    expect(none.every((t) => !t.isFraud)).toBe(true);
  });

  it('keeps each attack in order and compresses it into short runs', () => {
    const plan = planRun(new Random(8), world, {
      tps: 10,
      durationSeconds: 60, // shorter than the 30-minute travel gap
      fraudRate: 0.1,
      scenario: 'impossible_travel',
    });
    const abroad = plan
      .map((tx, index) => ({ tx, index }))
      .filter(({ tx }) => tx.scenario === 'impossible_travel');
    expect(abroad.length).toBeGreaterThan(0);
    for (const { tx, index } of abroad) {
      // The same account's home purchase comes earlier in the run.
      const before = plan.slice(0, index).some((t) => t.account === tx.account && !t.isFraud);
      expect(before).toBe(true);
    }
  });
});

describe('accountHistory', () => {
  it('builds 30 days of time-ordered normal traffic, mostly in daytime', () => {
    const end = new Date('2026-10-01T12:00:00Z');
    const random = new Random(9);
    const all = world.accounts.flatMap((account) =>
      accountHistory(random, world, account, { days: 30, end }),
    );
    for (const account of world.accounts.slice(0, 20)) {
      const own = all.filter((h) => h.tx.account === account);
      expect(own.length).toBeGreaterThanOrEqual(5);
      const times = own.map((h) => h.at.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
    expect(all.every((h) => h.at < end && !h.tx.isFraud)).toBe(true);
    expect(all.every((h) => h.at.getTime() >= end.getTime() - 31 * 86_400_000)).toBe(true);
    const night = all.filter((h) => localHour('BR', h.at) < 6).length / all.length;
    expect(night).toBeLessThan(0.05);
    // Enough history for the anomaly baseline to leave cold start (n >= 10, SPEC §6.5).
    const perAccount = all.length / world.accounts.length;
    expect(perAccount).toBeGreaterThan(14);
  });
});
