import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../domain/random.js';
import { planRun } from '../domain/traffic.js';
import { buildWorld } from '../domain/world.js';
import { groundTruthLine, httpSender, runTraffic, type GroundTruthRow } from './run.js';

const world = buildWorld(42, 100);

/** A stand-in for transaction-api: records arrival times and idempotency keys, answers 202. */
let server: Server;
let url: string;
const arrivals: number[] = [];
const keys = new Set<string>();
let counter = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    arrivals.push(performance.now());
    keys.add(String(req.headers['idempotency-key']));
    req.resume();
    req.on('end', () => {
      counter++;
      const id = `0190a0b0-0000-7000-8000-${String(counter).padStart(12, '0')}`;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ transactionId: id, status: 'PENDING' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('runTraffic', () => {
  it(
    'holds 100 tps within ±5% for 30 s, one Idempotency-Key per request, one label per 202',
    { timeout: 60_000 },
    async () => {
      const plan = planRun(new Random(1), world, {
        tps: 100,
        durationSeconds: 30,
        fraudRate: 0.02,
      });
      const rows: GroundTruthRow[] = [];
      const stats = await runTraffic({
        tps: 100,
        plan,
        send: httpSender(url, 'fsk_test'),
        onAccepted: (row) => rows.push(row),
      });

      expect(stats.sent).toBe(3000);
      expect(stats.accepted).toBe(3000);
      expect(keys.size).toBe(3000);
      expect(rows).toHaveLength(3000);
      expect(rows.filter((r) => r.isFraud).length).toBe(plan.filter((t) => t.isFraud).length);

      const seconds = stats.elapsedMs / 1000;
      expect(seconds).toBeGreaterThan(30 * 0.95);
      expect(seconds).toBeLessThan(30 * 1.05);
      // Rate in every 5 s window, not just on average.
      const first = arrivals[0] ?? 0;
      for (let w = 0; w < 6; w++) {
        const inWindow = arrivals.filter(
          (t) => t - first >= w * 5000 && t - first < (w + 1) * 5000,
        ).length;
        expect(inWindow).toBeGreaterThanOrEqual(500 * 0.95);
        expect(inWindow).toBeLessThanOrEqual(500 * 1.05);
      }
    },
  );

  it('counts rejected requests separately and never labels them', async () => {
    const plan = planRun(new Random(2), world, { tps: 200, durationSeconds: 1, fraudRate: 0 });
    let n = 0;
    const rows: GroundTruthRow[] = [];
    const stats = await runTraffic({
      tps: 200,
      plan,
      send: () => {
        n++;
        if (n % 4 === 0) return Promise.resolve({ status: 429 });
        if (n % 5 === 0) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve({ status: 202, transactionId: `id-${n}` });
      },
      onAccepted: (row) => rows.push(row),
    });
    expect(stats.sent).toBe(200);
    expect(stats.accepted + (stats.rejected['429'] ?? 0) + (stats.rejected['0'] ?? 0)).toBe(200);
    expect(rows).toHaveLength(stats.accepted);
  });

  it('writes ground truth lines in the CSV column order', () => {
    expect(
      groundTruthLine({
        transactionId: 'abc',
        isFraud: true,
        scenario: 'card_testing',
        accountId: 'acc_sim_000001',
      }),
    ).toBe('abc,true,card_testing,acc_sim_000001');
  });
});
