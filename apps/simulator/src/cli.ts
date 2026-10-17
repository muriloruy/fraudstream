import { isScenario, type Scenario } from './domain/traffic.js';

export interface SeedArgs {
  command: 'seed';
  accounts: number;
  seed: number;
  days: number;
}

export interface RunArgs {
  command: 'run';
  accounts: number;
  seed: number;
  tps: number;
  durationSeconds: number;
  fraudRate: number;
  scenario?: Scenario;
  out: string;
}

const DEFAULTS = { accounts: 10_000, seed: 42, days: 30 };

/** `30s`, `5m`, `1h` or plain seconds. */
export function parseDuration(value: string): number {
  // Bounded quantifiers only, no nested repetition: not vulnerable to ReDoS.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(\d{1,9}(?:\.\d{1,3})?)([smh])?$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration "${value}" (use e.g. 30s, 5m, 1h)`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  return amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
}

function positive(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

/** Parses `seed --accounts N` / `run --tps N --duration D --fraud-rate R [--scenario S]`. */
export function parseArgs(argv: readonly string[]): SeedArgs | RunArgs {
  const [command, ...rest] = argv.filter((a) => a !== '--');
  const flags = new Map<string, string>();
  for (let flag = rest.shift(); flag !== undefined; flag = rest.shift()) {
    if (!flag.startsWith('--')) throw new Error(`unexpected argument "${flag}"`);
    const [name, inline] = flag.slice(2).split('=', 2);
    const value = inline ?? rest.shift();
    if (!name || value === undefined) throw new Error(`missing value for ${flag}`);
    flags.set(name, value);
  }
  const accounts = Math.round(positive('accounts', flags.get('accounts'), DEFAULTS.accounts));
  const seed = Math.round(positive('seed', flags.get('seed'), DEFAULTS.seed));

  if (command === 'seed') {
    return {
      command,
      accounts,
      seed,
      days: Math.round(positive('days', flags.get('days'), DEFAULTS.days)),
    };
  }
  if (command === 'run') {
    const scenario = flags.get('scenario');
    if (scenario !== undefined && !isScenario(scenario)) {
      throw new Error(`unknown scenario "${scenario}"`);
    }
    const fraudRate = Number(flags.get('fraud-rate') ?? '0.02');
    if (!(fraudRate >= 0 && fraudRate < 1)) throw new Error('--fraud-rate must be in [0, 1)');
    return {
      command,
      accounts,
      seed,
      tps: positive('tps', flags.get('tps'), 100),
      durationSeconds: parseDuration(flags.get('duration') ?? '1m'),
      fraudRate,
      ...(scenario ? { scenario } : {}),
      out: flags.get('out') ?? 'simulator_output/ground_truth.csv',
    };
  }
  throw new Error('usage: simulator <seed|run> [options] (see apps/simulator/README.md)');
}
