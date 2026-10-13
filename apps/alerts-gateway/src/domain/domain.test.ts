import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, InvalidCursorError } from './cursor.js';
import { parseDurationMs } from './duration.js';
import { afterFailure, afterSuccess, isLocked, LOCKOUT_MS, type LoginState } from './lockout.js';
import { latencyBucketsFor, parseWindowSeconds, quantileMs, summarize } from './stats.js';
import { AlertRingBuffer, formatSse, StreamQueue, type StreamEvent } from './stream-queue.js';

describe('keyset cursor', () => {
  const key = randomBytes(32);
  const cursor = {
    finalScore: '0.6960',
    createdAt: '2026-10-12T18:00:00.123456Z',
    alertId: '0192f1c4-0000-7000-8000-000000000001',
  };

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor, key), key)).toEqual(cursor);
  });

  it.each([
    ['a flipped body byte', (t: string) => `x${t.slice(1)}`],
    ['a forged mac', (t: string) => `${t.split('.')[0] ?? ''}.${'A'.repeat(43)}`],
    ['another key', (t: string) => encodeCursor(cursor, randomBytes(32)) + t.slice(0, 0)],
    ['garbage', () => 'not-a-cursor'],
    ['an extra segment', (t: string) => `${t}.x`],
  ])('rejects %s', (_name, tamper) => {
    expect(() => decodeCursor(tamper(encodeCursor(cursor, key)), key)).toThrow(InvalidCursorError);
  });

  it('rejects a correctly signed cursor with values of the wrong shape', () => {
    const bad = encodeCursor({ ...cursor, finalScore: '1; DROP TABLE alerts' }, key);
    expect(() => decodeCursor(bad, key)).toThrow(InvalidCursorError);
  });
});

describe('lockout (SPEC §7 Req. 8)', () => {
  const now = new Date('2026-10-12T12:00:00Z');

  it('locks for 15 minutes on the 5th consecutive failure', () => {
    let s = afterSuccess();
    for (let i = 0; i < 4; i++) s = afterFailure(s, now);
    expect(isLocked(s, now)).toBe(false);
    s = afterFailure(s, now);
    expect(s.failedLogins).toBe(5);
    expect(isLocked(s, now)).toBe(true);
    expect(isLocked(s, new Date(now.getTime() + LOCKOUT_MS - 1))).toBe(true);
    expect(isLocked(s, new Date(now.getTime() + LOCKOUT_MS))).toBe(false);
  });

  it('starts counting again after an expired lockout, and success resets', () => {
    let s: LoginState = { failedLogins: 5, lockedUntil: new Date(now.getTime() - 1) };
    s = afterFailure(s, now);
    expect(s).toEqual({ failedLogins: 1, lockedUntil: null });
    expect(afterSuccess()).toEqual({ failedLogins: 0, lockedUntil: null });
  });
});

describe('durations', () => {
  it('parses config durations and summary windows', () => {
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('7d')).toBe(604_800_000);
    expect(() => parseDurationMs('15 minutes')).toThrow();
    expect(parseWindowSeconds('15m')).toBe(900);
    expect(parseWindowSeconds('2d')).toBeNull();
    expect(parseWindowSeconds('0s')).toBeNull();
    expect(parseWindowSeconds("15m' OR 1=1")).toBeNull();
  });
});

describe('decision statistics', () => {
  it('estimates p95 from the histogram', () => {
    const counts = latencyBucketsFor(0).map(() => 0);
    // 100 decisions: 90 within 100 ms, 10 within 300 ms
    counts[1] = 90;
    counts[3] = 10;
    expect(quantileMs(counts, 0.95)).toBe(250); // halfway into the 200-300 bucket
    expect(
      quantileMs(
        counts.map(() => 0),
        0.95,
      ),
    ).toBeNull();
    expect(latencyBucketsFor(99_999).at(-1)).toBe(1);
  });

  it('summarizes counts into rates and tx/s', () => {
    const latencyBuckets = latencyBucketsFor(180);
    expect(summarize({ approve: 6, review: 3, decline: 1, latencyBuckets }, 10)).toEqual({
      windowSeconds: 10,
      decisions: 10,
      transactionsPerSecond: 1,
      rates: { approve: 0.6, review: 0.3, decline: 0.1 },
      p95LatencyMs: 195,
    });
  });
});

describe('SSE backpressure and resume', () => {
  const ev = (id: number, type: StreamEvent['type']): StreamEvent => ({ id, type, data: { id } });

  it('drops decision samples but never alerts when a slow client falls behind', () => {
    const q = new StreamQueue(50);
    let id = 0;
    for (let i = 0; i < 1000; i++) {
      q.push(ev(++id, 'decision.made'));
      if (i % 200 === 0) q.push(ev(++id, 'alert.created'));
    }
    const out: StreamEvent[] = [];
    for (let e = q.shift(); e; e = q.shift()) out.push(e);
    expect(out.filter((e) => e.type === 'alert.created')).toHaveLength(5);
    expect(out.filter((e) => e.type === 'decision.made').length).toBeLessThan(1000);
    expect(q.dropped).toBeGreaterThan(900);
    expect(out.map((e) => e.id)).toEqual([...out.map((e) => e.id)].sort((a, b) => a - b));
  });

  it('keeps alerts beyond the limit when the queue holds only alerts', () => {
    const q = new StreamQueue(2);
    for (let i = 1; i <= 3; i++) q.push(ev(i, 'alert.updated'));
    q.push(ev(4, 'decision.made'));
    expect(q.size).toBe(3);
  });

  it('resumes missed alert events after Last-Event-ID', () => {
    const ring = new AlertRingBuffer(3);
    [
      ev(1, 'alert.created'),
      ev(2, 'decision.made'),
      ev(3, 'alert.created'),
      ev(4, 'alert.updated'),
      ev(5, 'alert.created'),
      ev(6, 'alert.created'),
    ].forEach((e) => {
      ring.add(e);
    });
    expect(ring.since(3).map((e) => e.id)).toEqual([4, 5, 6]);
    expect(ring.since(0).map((e) => e.id)).toEqual([4, 5, 6]); // capacity 3: 1 and 3 are gone
  });

  it('formats one event per frame with JSON data on a single line', () => {
    expect(formatSse({ id: 7, type: 'alert.created', data: { note: 'a\nb' } })).toBe(
      'id: 7\nevent: alert.created\ndata: {"note":"a\\nb"}\n\n',
    );
  });
});
