/**
 * Seeded pseudo-random generator (mulberry32) so a simulation is reproducible from `--seed`
 * (M7 design). Not cryptographic: it only shapes synthetic traffic.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new RangeError('cannot pick from an empty list');
    return item;
  }

  /** Standard normal (Box-Muller). */
  normal(): number {
    const u = 1 - this.next(); // (0, 1]: log(0) is avoided
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Lognormal with the given parameters of the underlying normal. */
  lognormal(mu: number, sigma: number): number {
    return Math.exp(mu + sigma * this.normal());
  }

  /** Exponential inter-arrival time of a Poisson process with `rate` events per unit. */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }

  /** An independent generator derived from this seed and a label (stable across runs). */
  fork(label: string): Random {
    let h = this.state ^ 0x9e3779b9;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
    }
    return new Random(h >>> 0);
  }
}
