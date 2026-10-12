import { describe, expect, it } from 'vitest';
import { loadRuleset, parseRuleset } from '../config/ruleset-loader.js';
import { evaluate, haversineKm, RULES, type RuleContext, type TransactionFacts } from './rules.js';

const ruleset = loadRuleset();
const SAO_PAULO = { lat: -23.55, lon: -46.63 };
const LISBON = { lat: 38.72, lon: -9.14 };

const tx = (over: Partial<TransactionFacts> = {}): TransactionFacts => ({
  transactionId: 't1',
  accountId: 'acc_1',
  amountCents: 10_000n, // 100.00
  merchantId: 'mer_1',
  mcc: '5411',
  country: 'BR',
  bin: '411111',
  requestedAt: new Date('2026-10-12T15:00:00Z'), // 12:00 in São Paulo
  geo: SAO_PAULO,
  ...over,
});

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  countInVelocityWindow: 0,
  sumInAmountWindowCents: 0n,
  smallInTestingWindow: 0,
  historyCount: 20,
  historySumCents: 200_000n, // average 100.00
  last: null,
  knownMerchant: true,
  blocklistHits: [],
  profile: { homeCountry: 'BR', creditLimitCents: 800_000n }, // 8000.00
  ...over,
});

const fired = (id: keyof typeof RULES, t = tx(), c = ctx()) => RULES[id](t, c, ruleset) !== null;

describe('ruleset', () => {
  it('loads rules.yaml with every rule', () => {
    expect(ruleset.version).toBe('2026.10.1');
    expect(Object.keys(ruleset.rules)).toHaveLength(10);
  });

  it('rejects an invalid ruleset', () => {
    expect(() => parseRuleset('version: x\ndefaultCreditLimit: "10"\nrules: {}')).toThrow(
      /invalid ruleset: rules\.R001/,
    );
    const text = `version: '1'\ndefaultCreditLimit: 1000\nrules: {}`;
    expect(() => parseRuleset(text)).toThrow(/defaultCreditLimit/);
  });
});

describe('a normal transaction fires nothing', () => {
  it('scores 0', () => {
    expect(evaluate(tx(), ctx(), ruleset)).toEqual({
      ruleScore: 0,
      hardDecline: false,
      firedRules: [],
    });
  });
});

describe.each([
  [
    'R001 velocity_1m: 5th transaction in 60 s',
    'R001',
    tx(),
    ctx({ countInVelocityWindow: 4 }),
    false,
  ],
  [
    'R001 velocity_1m: 6th transaction in 60 s',
    'R001',
    tx(),
    ctx({ countInVelocityWindow: 5 }),
    true,
  ],
  [
    'R002: exactly 50% of the limit',
    'R002',
    tx({ amountCents: 100_000n }),
    ctx({ sumInAmountWindowCents: 300_000n }),
    false,
  ],
  [
    'R002: just over 50% of the limit',
    'R002',
    tx({ amountCents: 100_001n }),
    ctx({ sumInAmountWindowCents: 300_000n }),
    true,
  ],
  [
    'R002: default limit when no profile',
    'R002',
    tx({ amountCents: 250_001n }),
    ctx({ profile: null }),
    true,
  ],
  ['R003: 5x average exactly', 'R003', tx({ amountCents: 50_000n }), ctx(), false],
  ['R003: above 5x average', 'R003', tx({ amountCents: 50_001n }), ctx(), true],
  [
    'R003: 9 past transactions is not enough history',
    'R003',
    tx({ amountCents: 900_000n }),
    ctx({ historyCount: 9, historySumCents: 90_000n }),
    false,
  ],
  [
    'R003: 10 past transactions',
    'R003',
    tx({ amountCents: 900_000n }),
    ctx({ historyCount: 10, historySumCents: 100_000n }),
    true,
  ],
  [
    'R004: São Paulo then Lisbon 30 min later',
    'R004',
    tx({ country: 'PT', geo: LISBON }),
    ctx({ last: { country: 'BR', ...SAO_PAULO, at: new Date('2026-10-12T14:30:00Z') } }),
    true,
  ],
  [
    'R004: same trip 12 h later is plausible',
    'R004',
    tx({ country: 'PT', geo: LISBON }),
    ctx({ last: { country: 'BR', ...SAO_PAULO, at: new Date('2026-10-12T03:00:00Z') } }),
    false,
  ],
  [
    'R004: same country never fires',
    'R004',
    tx(),
    ctx({ last: { country: 'BR', lat: 2, lon: 2, at: new Date('2026-10-12T14:59:00Z') } }),
    false,
  ],
  [
    'R004: no geo on the transaction',
    'R004',
    tx({ country: 'PT', geo: undefined }),
    ctx({ last: { country: 'BR', ...SAO_PAULO, at: new Date('2026-10-12T14:59:00Z') } }),
    false,
  ],
  ['R005: foreign merchant', 'R005', tx({ country: 'PT' }), ctx(), true],
  ['R005: unknown profile', 'R005', tx({ country: 'PT' }), ctx({ profile: null }), false],
  [
    'R006: 2nd small transaction',
    'R006',
    tx({ amountCents: 199n }),
    ctx({ smallInTestingWindow: 1 }),
    false,
  ],
  [
    'R006: 3rd small transaction',
    'R006',
    tx({ amountCents: 199n }),
    ctx({ smallInTestingWindow: 2 }),
    true,
  ],
  [
    'R006: exactly 5.00 is not small',
    'R006',
    tx({ amountCents: 500n }),
    ctx({ smallInTestingWindow: 2 }),
    false,
  ],
  [
    'R007: new merchant, 2000.00 exactly',
    'R007',
    tx({ amountCents: 200_000n }),
    ctx({ knownMerchant: false }),
    false,
  ],
  [
    'R007: new merchant above 2000.00',
    'R007',
    tx({ amountCents: 200_001n }),
    ctx({ knownMerchant: false, historySumCents: 0n }),
    true,
  ],
  ['R007: known merchant above 2000.00', 'R007', tx({ amountCents: 200_001n }), ctx(), false],
  ['R008: blocklisted MCC', 'R008', tx(), ctx({ blocklistHits: ['MCC:7995'] }), true],
  [
    'R009: 02:00 local, 3x average + 0.01',
    'R009',
    tx({ amountCents: 30_001n, requestedAt: new Date('2026-10-12T05:00:00Z') }),
    ctx(),
    true,
  ],
  [
    'R009: 05:00 local is daytime',
    'R009',
    tx({ amountCents: 30_001n, requestedAt: new Date('2026-10-12T08:00:00Z') }),
    ctx(),
    false,
  ],
  [
    'R009: night but 3x average exactly',
    'R009',
    tx({ amountCents: 30_000n, requestedAt: new Date('2026-10-12T05:00:00Z') }),
    ctx(),
    false,
  ],
  ['R010: within available credit', 'R010', tx({ amountCents: 600_000n }), ctx(), false],
  ['R010: over available credit', 'R010', tx({ amountCents: 600_001n }), ctx(), true],
] as const)('%s', (_label, id, t, c, expected) => {
  it(expected ? 'fires' : 'does not fire', () => {
    expect(fired(id, t, c)).toBe(expected);
  });
});

describe('evaluate', () => {
  it('caps the score at 1 and flags hard declines', () => {
    const result = evaluate(
      tx({ amountCents: 199n, country: 'PT' }),
      ctx({ countInVelocityWindow: 9, smallInTestingWindow: 5, blocklistHits: ['BIN:411111'] }),
      ruleset,
    );
    expect(result.firedRules.map((h) => h.ruleId)).toEqual(['R001', 'R005', 'R006', 'R008']);
    expect(result.ruleScore).toBe(1);
    expect(result.hardDecline).toBe(true);
  });

  it('adds points', () => {
    const result = evaluate(tx({ country: 'PT' }), ctx({ countInVelocityWindow: 5 }), ruleset);
    expect(result.ruleScore).toBe(0.4); // R001 30 + R005 10
    expect(result.hardDecline).toBe(false);
    expect(result.firedRules[0]?.details).toEqual({ countLast60s: 6, threshold: 5 });
  });
});

describe('haversineKm', () => {
  it('measures São Paulo to Lisbon (~7,900 km)', () => {
    expect(Math.round(haversineKm(SAO_PAULO, LISBON) / 100)).toBe(79);
    expect(haversineKm(SAO_PAULO, SAO_PAULO)).toBe(0);
  });
});
