import type { Random } from './random.js';
import {
  centsToAmount,
  ELECTRONICS_MCC,
  LISBON,
  medianCents,
  normalAmount,
  type Account,
  type Merchant,
  type World,
} from './world.js';

export const SCENARIOS = [
  'normal',
  'card_testing',
  'account_takeover',
  'impossible_travel',
  'merchant_compromise',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type FraudScenario = Exclude<Scenario, 'normal'>;
export const FRAUD_SCENARIOS: readonly FraudScenario[] = SCENARIOS.filter(
  (s): s is FraudScenario => s !== 'normal',
);

export function isScenario(value: string): value is Scenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** One transaction the simulator will send, with its label (the ground truth). */
export interface PlannedTransaction {
  account: Account;
  merchant: Merchant;
  amount: string;
  channel: 'ECOMMERCE' | 'POS';
  entryMode: 'CARD_NOT_PRESENT' | 'CHIP' | 'CONTACTLESS';
  deviceId: string;
  ip: string;
  geo: { lat: number; lon: number };
  isFraud: boolean;
  scenario: Scenario;
}

/** A transaction of an attack, `offsetSeconds` after the attack's first one. */
export interface TimedTransaction {
  offsetSeconds: number;
  tx: PlannedTransaction;
}

/** SPEC §6.9 `normal`: lognormal amount, mostly known merchants, home city, own device. */
export function normalTransaction(
  random: Random,
  world: World,
  account: Account,
): PlannedTransaction {
  const merchant = random.chance(0.85)
    ? random.pick(account.favorites)
    : random.pick(world.merchantsIn(account.homeCity));
  const present = random.chance(0.5);
  return {
    account,
    merchant,
    amount: normalAmount(random, account),
    channel: present ? 'POS' : 'ECOMMERCE',
    entryMode: present ? (random.chance(0.6) ? 'CONTACTLESS' : 'CHIP') : 'CARD_NOT_PRESENT',
    deviceId: account.deviceId,
    ip: account.ip,
    geo: jitter(random, merchant.city),
    isFraud: false,
    scenario: 'normal',
  };
}

/** SPEC §6.9 `card_testing`: a burst of 5-10 transactions of R$ 1-4 within minutes. */
export function cardTesting(random: Random, world: World): TimedTransaction[] {
  const account = random.pick(world.accounts);
  const merchant = random.pick(world.merchants.filter((m) => m.city.country === 'BR'));
  const deviceId = `dev-ct-${random.int(0, 0xffffff).toString(16)}`;
  const ip = `198.51.100.${random.int(1, 254)}`;
  const count = random.int(5, 10);
  const burst: TimedTransaction[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    burst.push({
      offsetSeconds: offset,
      tx: {
        account,
        merchant,
        amount: centsToAmount(random.int(100, 400)),
        channel: 'ECOMMERCE',
        entryMode: 'CARD_NOT_PRESENT',
        deviceId,
        ip,
        geo: jitter(random, merchant.city),
        isFraud: true,
        scenario: 'card_testing',
      },
    });
    offset += random.uniform(5, 30);
  }
  return burst;
}

/**
 * SPEC §6.9 `account_takeover`: sudden high amounts at merchants new to the account, from
 * a device the account never used.
 */
export function accountTakeover(random: Random, world: World): TimedTransaction[] {
  const account = random.pick(world.accounts);
  const favorites = new Set(account.favorites.map((m) => m.id));
  const unknown = world.merchantsIn(account.homeCity).filter((m) => !favorites.has(m.id));
  const electronics = unknown.filter((m) => m.mcc === ELECTRONICS_MCC);
  const deviceId = `dev-ato-${random.int(0, 0xffffff).toString(16)}`;
  const ip = `203.0.113.${random.int(1, 254)}`;
  const count = random.int(2, 4);
  const attack: TimedTransaction[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const merchant = random.pick(
      electronics.length > 0 && random.chance(0.7) ? electronics : unknown,
    );
    const cents = Math.max(80_000, medianCents(account) * random.uniform(8, 20));
    attack.push({
      offsetSeconds: offset,
      tx: {
        account,
        merchant,
        amount: centsToAmount(cents),
        channel: 'ECOMMERCE',
        entryMode: 'CARD_NOT_PRESENT',
        deviceId,
        ip,
        geo: jitter(random, merchant.city),
        isFraud: true,
        scenario: 'account_takeover',
      },
    });
    offset += random.uniform(30, 120);
  }
  return attack;
}

/**
 * SPEC §6.9 `impossible_travel`: a legitimate purchase at home, then a card-present
 * purchase in Lisbon 30 minutes later. The home purchase is labeled normal: only the
 * Lisbon one is fraud.
 */
export function impossibleTravel(random: Random, world: World): TimedTransaction[] {
  const account = random.pick(world.accounts);
  const home = normalTransaction(random, world, account);
  const merchant = random.pick(world.merchantsIn(LISBON));
  return [
    { offsetSeconds: 0, tx: home },
    {
      offsetSeconds: 30 * 60,
      tx: {
        account,
        merchant,
        amount: centsToAmount(medianCents(account) * random.uniform(1.5, 4)),
        channel: 'POS',
        entryMode: 'CHIP',
        deviceId: account.deviceId,
        ip: account.ip,
        geo: jitter(random, LISBON),
        isFraud: true,
        scenario: 'impossible_travel',
      },
    },
  ];
}

/**
 * SPEC §6.9 `merchant_compromise`: many accounts hitting the same merchant with amounts far
 * above their usual ones within a few minutes.
 */
export function merchantCompromise(random: Random, world: World): TimedTransaction[] {
  const merchant = random.pick(world.merchants.filter((m) => m.city.country === 'BR'));
  const count = random.int(8, 20);
  const victims = new Set<Account>();
  while (victims.size < Math.min(count, world.accounts.length)) {
    victims.add(random.pick(world.accounts));
  }
  return [...victims].map((account) => ({
    offsetSeconds: random.uniform(0, 300),
    tx: {
      account,
      merchant,
      amount: centsToAmount(medianCents(account) * random.uniform(4, 10)),
      channel: 'ECOMMERCE',
      entryMode: 'CARD_NOT_PRESENT',
      deviceId: account.deviceId,
      ip: account.ip,
      geo: jitter(random, merchant.city),
      isFraud: true,
      scenario: 'merchant_compromise',
    },
  }));
}

const ATTACKS: Record<FraudScenario, (random: Random, world: World) => TimedTransaction[]> = {
  card_testing: cardTesting,
  account_takeover: accountTakeover,
  impossible_travel: impossibleTravel,
  merchant_compromise: merchantCompromise,
};

export interface RunPlanOptions {
  tps: number;
  durationSeconds: number;
  /** Share of the transactions that are fraud (SPEC §6.9 `--fraud-rate`). */
  fraudRate: number;
  /**
   * Inject only this scenario (`normal` = no fraud at all). Normal background traffic is
   * always present, so the false positive rate stays measurable.
   */
  scenario?: Scenario;
}

/**
 * The live run as a dense sequence: transaction `i` is sent at `i / tps` seconds, so the
 * target rate holds by construction. Attacks are placed on the slots matching their
 * offsets (compressed proportionally when the run is shorter than the attack), in order;
 * every other slot is normal traffic.
 */
export function planRun(
  random: Random,
  world: World,
  options: RunPlanOptions,
): PlannedTransaction[] {
  const total = Math.max(1, Math.round(options.tps * options.durationSeconds));
  const slots = Array.from<PlannedTransaction | undefined>({ length: total });
  const scenarios =
    options.scenario === undefined
      ? FRAUD_SCENARIOS
      : options.scenario === 'normal'
        ? []
        : [options.scenario];
  const budget = Math.round(total * options.fraudRate);
  let fraud = 0;
  let failures = 0;
  for (let n = 0; scenarios.length > 0 && fraud < budget && failures < 50; n++) {
    const scenario = scenarios[n % scenarios.length];
    if (scenario === undefined) break;
    // eslint-disable-next-line security/detect-object-injection -- typed FraudScenario key
    const attack = ATTACKS[scenario](random, world);
    const placed = place(random, slots, attack, options.tps);
    if (placed) fraud += attack.filter((a) => a.tx.isFraud).length;
    else failures++;
  }
  return Array.from(
    slots,
    (slot) => slot ?? normalTransaction(random, world, random.pick(world.accounts)),
  );
}

function place(
  random: Random,
  slots: (PlannedTransaction | undefined)[],
  attack: readonly TimedTransaction[],
  tps: number,
): boolean {
  const last = slots.length - 1;
  const maxOffset = Math.max(...attack.map((a) => a.offsetSeconds * tps), 0);
  const scale = maxOffset > last ? last / maxOffset : 1;
  const start = random.int(0, Math.max(0, last - Math.floor(maxOffset * scale)));
  // Slot indices are integers computed here, never external input.
  /* eslint-disable security/detect-object-injection */
  const taken: number[] = [];
  let previous = -1;
  for (const { offsetSeconds, tx } of attack) {
    let index = Math.max(previous + 1, start + Math.floor(offsetSeconds * tps * scale));
    while (index <= last && slots[index] !== undefined) index++;
    if (index > last) {
      for (const t of taken) slots[t] = undefined;
      return false;
    }
    slots[index] = tx;
    /* eslint-enable security/detect-object-injection */
    taken.push(index);
    previous = index;
  }
  return true;
}

function jitter(random: Random, city: { lat: number; lon: number }): { lat: number; lon: number } {
  return {
    lat: Math.round((city.lat + random.uniform(-0.05, 0.05)) * 10_000) / 10_000,
    lon: Math.round((city.lon + random.uniform(-0.05, 0.05)) * 10_000) / 10_000,
  };
}
