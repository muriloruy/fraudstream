import { fromCents, type RiskTier } from '@fraudstream/contracts';
import { testPan } from './pan.js';
import { Random } from './random.js';

export interface City {
  name: string;
  country: 'BR' | 'PT';
  lat: number;
  lon: number;
}

export const SAO_PAULO: City = { name: 'São Paulo', country: 'BR', lat: -23.55, lon: -46.63 };
export const LISBON: City = { name: 'Lisboa', country: 'PT', lat: 38.72, lon: -9.14 };

/** Home cities of the simulated accounts (all in Brazil). */
export const HOME_CITIES: readonly City[] = [
  SAO_PAULO,
  { name: 'Rio de Janeiro', country: 'BR', lat: -22.91, lon: -43.17 },
  { name: 'Belo Horizonte', country: 'BR', lat: -19.92, lon: -43.94 },
  { name: 'Curitiba', country: 'BR', lat: -25.43, lon: -49.27 },
  { name: 'Porto Alegre', country: 'BR', lat: -30.03, lon: -51.23 },
  { name: 'Brasília', country: 'BR', lat: -15.79, lon: -47.88 },
  { name: 'Salvador', country: 'BR', lat: -12.97, lon: -38.5 },
  { name: 'Recife', country: 'BR', lat: -8.05, lon: -34.88 },
];

/** Everyday merchant categories; electronics is also what takeovers go after. */
const MCCS = ['5411', '5812', '5541', '5912', '5651', '5999', '4121', '5732'] as const;
export const ELECTRONICS_MCC = '5732';

export interface Merchant {
  id: string;
  name: string;
  mcc: string;
  city: City;
}

export interface Card {
  pan: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
}

export interface Account {
  accountId: string;
  homeCity: City;
  riskTier: RiskTier;
  creditLimit: string;
  /** Lognormal parameters of the purchase amount in BRL (SPEC §6.9 `normal`). */
  amountMu: number;
  amountSigma: number;
  /** Mean purchases per day of the account's Poisson arrivals. */
  dailyRate: number;
  /** Merchants the account usually buys from ("mostly known merchants"). */
  favorites: readonly Merchant[];
  card: Card;
  deviceId: string;
  ip: string;
}

export interface World {
  accounts: readonly Account[];
  merchants: readonly Merchant[];
  /** Merchants of a city, to pick new (non-favorite) merchants nearby. */
  merchantsIn: (city: City) => readonly Merchant[];
}

const CREDIT_LIMIT_CENTS: Record<RiskTier, [number, number]> = {
  LOW: [800_000, 2_000_000],
  MEDIUM: [300_000, 800_000],
  HIGH: [100_000, 300_000],
};

const MERCHANTS_PER_CITY = 60;

export function accountId(index: number): string {
  return `acc_sim_${String(index).padStart(6, '0')}`;
}

/**
 * The simulated population, fully determined by `seed` and `size`: `sim:seed` and `sim:run`
 * rebuild the same accounts, cards and merchants from the same arguments.
 */
export function buildWorld(seed: number, size: number): World {
  const random = new Random(seed).fork('world');
  const merchants: Merchant[] = [];
  const byCity = new Map<string, Merchant[]>();
  for (const city of [...HOME_CITIES, LISBON]) {
    const local: Merchant[] = [];
    for (let i = 0; i < MERCHANTS_PER_CITY; i++) {
      const id = `mer_sim_${city.country.toLowerCase()}${byCity.size}_${String(i).padStart(3, '0')}`;
      local.push({ id, name: `Loja ${city.name} ${i + 1}`, mcc: random.pick(MCCS), city });
    }
    byCity.set(city.name, local);
    merchants.push(...local);
  }
  const merchantsIn = (city: City): readonly Merchant[] => byCity.get(city.name) ?? [];

  const accounts: Account[] = [];
  for (let index = 0; index < size; index++) {
    const homeCity = random.pick(HOME_CITIES);
    const riskTier: RiskTier = random.chance(0.6) ? 'LOW' : random.chance(0.75) ? 'MEDIUM' : 'HIGH';
    // eslint-disable-next-line security/detect-object-injection -- `riskTier` is a typed enum value
    const [minLimit, maxLimit] = CREDIT_LIMIT_CENTS[riskTier];
    const local = merchantsIn(homeCity);
    const favorites = new Set<Merchant>();
    const wanted = random.int(4, 8);
    while (favorites.size < wanted) favorites.add(random.pick(local));
    accounts.push({
      accountId: accountId(index),
      homeCity,
      riskTier,
      creditLimit: fromCents(BigInt(random.int(minLimit / 100, maxLimit / 100) * 100)),
      amountMu: Math.log(random.uniform(40, 250)),
      amountSigma: random.uniform(0.4, 0.8),
      dailyRate: random.uniform(0.5, 1.2),
      favorites: [...favorites],
      card: {
        pan: testPan(random),
        expiryMonth: random.int(1, 12),
        expiryYear: random.int(2028, 2032),
        cvv: String(random.int(100, 999)),
      },
      deviceId: `dev-${index.toString(36)}-${random.int(0, 0xffffff).toString(16)}`,
      ip: `10.${random.int(0, 255)}.${random.int(0, 255)}.${random.int(1, 254)}`,
    });
  }
  return { accounts, merchants, merchantsIn };
}

/**
 * A purchase amount from the account's lognormal distribution, as a decimal string. The
 * distribution is sampled in floating point but the amount is rounded to whole cents and
 * carried as a string from there on (ADR-009).
 */
export function normalAmount(random: Random, account: Account): string {
  return centsToAmount(Math.round(random.lognormal(account.amountMu, account.amountSigma) * 100));
}

/** The account's typical (median) amount in cents. */
export function medianCents(account: Account): number {
  return Math.round(Math.exp(account.amountMu) * 100);
}

/** Whole cents to a decimal string, never below 1.00. */
export function centsToAmount(cents: number): string {
  return fromCents(BigInt(Math.max(100, Math.round(cents))));
}
