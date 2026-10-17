import { isDecimalString, toCents } from '@fraudstream/contracts';
import { describe, expect, it } from 'vitest';
import { isTestPan, luhnCheckDigit, testPan, TEST_BINS } from './pan.js';
import { Random } from './random.js';
import { buildWorld, centsToAmount, medianCents, normalAmount } from './world.js';

describe('Random', () => {
  it('is reproducible from its seed', () => {
    const a = new Random(42);
    const b = new Random(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
    expect(new Random(1).next()).not.toBe(new Random(2).next());
  });

  it('samples the requested distributions', () => {
    const random = new Random(7);
    const n = 50_000;
    const normals = Array.from({ length: n }, () => random.normal());
    const mean = normals.reduce((s, x) => s + x, 0) / n;
    const variance = normals.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    expect(mean).toBeCloseTo(0, 1);
    expect(variance).toBeCloseTo(1, 1);

    const waits = Array.from({ length: n }, () => random.exponential(4));
    expect(waits.reduce((s, x) => s + x, 0) / n).toBeCloseTo(0.25, 2);

    const logs = Array.from({ length: n }, () => Math.log(random.lognormal(Math.log(100), 0.5)));
    expect(logs.reduce((s, x) => s + x, 0) / n).toBeCloseTo(Math.log(100), 1);
  });
});

describe('test PANs (SPEC §6.9)', () => {
  it('builds Luhn-valid PANs inside the documented test ranges only', () => {
    const random = new Random(1);
    for (let i = 0; i < 1000; i++) {
      const pan = testPan(random);
      expect(isTestPan(pan)).toBe(true);
      expect(TEST_BINS.some((bin) => pan.startsWith(bin))).toBe(true);
    }
  });

  it('computes the check digit of the published test cards', () => {
    expect(luhnCheckDigit('411111111111111')).toBe('1');
    expect(luhnCheckDigit('555555555555444')).toBe('4');
    expect(isTestPan('4111111111111112')).toBe(false); // bad check digit
    expect(isTestPan('4929000000000006')).toBe(false); // outside the test ranges
  });
});

describe('world', () => {
  it('is the same for the same seed and size', () => {
    const a = buildWorld(42, 50);
    const b = buildWorld(42, 50);
    expect(a.accounts).toEqual(b.accounts);
    expect(buildWorld(43, 50).accounts).not.toEqual(a.accounts);
  });

  it('gives every account sane, distinct parameters', () => {
    const world = buildWorld(42, 500);
    const { accounts } = world;
    expect(new Set(accounts.map((a) => a.accountId)).size).toBe(500);
    for (const account of accounts) {
      expect(isTestPan(account.card.pan)).toBe(true);
      expect(isDecimalString(account.creditLimit)).toBe(true);
      expect(medianCents(account)).toBeGreaterThanOrEqual(4000);
      expect(medianCents(account)).toBeLessThanOrEqual(25000);
      expect(account.amountSigma).toBeGreaterThanOrEqual(0.4);
      expect(account.amountSigma).toBeLessThanOrEqual(0.8);
      expect(account.favorites.length).toBeGreaterThanOrEqual(4);
      // Favorites are local merchants: normal traffic stays in the home city.
      const local = new Set(world.merchantsIn(account.homeCity).map((m) => m.id));
      expect(account.favorites.every((m) => local.has(m.id))).toBe(true);
    }
    const tiers = new Set(accounts.map((a) => a.riskTier));
    expect(tiers).toEqual(new Set(['LOW', 'MEDIUM', 'HIGH']));
  });

  it('samples amounts as whole-cent decimal strings around the account median', () => {
    const random = new Random(3);
    const [account] = buildWorld(42, 1).accounts;
    if (!account) throw new Error('no account');
    const cents = Array.from({ length: 5000 }, () => {
      const amount = normalAmount(random, account);
      expect(isDecimalString(amount)).toBe(true);
      return Number(toCents(amount));
    }).sort((x, y) => x - y);
    const median = cents[2500] ?? 0;
    expect(median / medianCents(account)).toBeGreaterThan(0.9);
    expect(median / medianCents(account)).toBeLessThan(1.1);
    expect(centsToAmount(12)).toBe('1.00');
  });
});
