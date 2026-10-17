import { describe, expect, it } from 'vitest';
import { parseArgs, parseDuration } from './cli.js';

describe('simulator CLI', () => {
  it('parses durations', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('90')).toBe(90);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
  });

  it('parses sim:seed and sim:run as pnpm passes them', () => {
    expect(parseArgs(['seed', '--', '--accounts', '100'])).toEqual({
      command: 'seed',
      accounts: 100,
      seed: 42,
      days: 30,
    });
    expect(
      parseArgs([
        'run',
        '--tps',
        '100',
        '--duration',
        '5m',
        '--fraud-rate=0.02',
        '--scenario',
        'card_testing',
      ]),
    ).toMatchObject({
      command: 'run',
      tps: 100,
      durationSeconds: 300,
      fraudRate: 0.02,
      scenario: 'card_testing',
      out: 'simulator_output/ground_truth.csv',
    });
  });

  it('rejects bad input', () => {
    expect(() => parseArgs(['run', '--scenario', 'heist'])).toThrow(/unknown scenario/);
    expect(() => parseArgs(['run', '--fraud-rate', '2'])).toThrow(/fraud-rate/);
    expect(() => parseArgs(['seed', '--accounts', '-1'])).toThrow(/positive/);
    expect(() => parseArgs(['launch'])).toThrow(/usage/);
  });
});
