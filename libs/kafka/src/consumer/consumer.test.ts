import { AnomalyScored, createEnvelope, FraudRulesEvaluated, uuidv7 } from '@fraudstream/contracts';
import { createMetricsRegistry } from '@fraudstream/observability';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  childEnvelope,
  classifyError,
  consumerMetrics,
  decodeEvent,
  incomingTraceparent,
  normalizeHeaders,
  PermanentError,
  retryInProcess,
  retryRoundDelayMs,
  TransientError,
} from './index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8');

describe('classifyError', () => {
  it.each([
    [new TransientError('x'), 'transient'],
    [new PermanentError('invariant', 'x'), 'permanent'],
    [Object.assign(new Error('conn'), { code: 'ECONNREFUSED' }), 'transient'],
    [Object.assign(new Error('serialization'), { code: '40001' }), 'transient'],
    [Object.assign(new Error('deadlock'), { code: '40P01' }), 'transient'],
    [Object.assign(new Error('admin shutdown'), { code: '57P01' }), 'transient'],
    [Object.assign(new Error('connection failure'), { code: '08006' }), 'transient'],
    [Object.assign(new Error('unique'), { code: '23505' }), 'permanent'],
    [new Error('who knows'), 'transient'],
    ['a string', 'transient'],
  ])('%s -> %s', (error, expected) => {
    expect(classifyError(error)).toBe(expected);
  });
});

describe('decodeEvent', () => {
  const defs = [FraudRulesEvaluated, AnomalyScored];

  it('picks the definition by eventType and version and returns a typed envelope', () => {
    const { definition, envelope } = decodeEvent(Buffer.from(fixture('anomaly-scored')), defs);
    expect(definition).toBe(AnomalyScored);
    expect(envelope.eventType).toBe('AnomalyScored');
  });

  it.each([
    ['null value', null, 'schema-validation'],
    ['not JSON', 'nope{', 'schema-validation'],
    [
      'unknown event type',
      JSON.stringify({ eventType: 'Other', eventVersion: 1 }),
      'unknown-event',
    ],
    [
      'unknown version',
      fixture('anomaly-scored').replace('"eventVersion": 1', '"eventVersion": 2'),
      'unknown-event',
    ],
    [
      'invalid payload',
      fixture('anomaly-scored').replace('"anomalyScore": 0.81', '"anomalyScore": 7'),
      'schema-validation',
    ],
  ])('%s is a permanent error', (_label, value, reason) => {
    try {
      decodeEvent(value, defs);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).reason).toBe(reason);
    }
  });

  it('ignores unknown fields (SPEC §4.10)', () => {
    const value = fixture('anomaly-scored').replace(
      '"modelVersion"',
      '"newField": 1, "modelVersion"',
    );
    const { envelope } = decodeEvent(value, defs);
    expect(envelope.payload).not.toHaveProperty('newField');
  });
});

describe('context propagation', () => {
  it('keeps the correlation id and chains causation', () => {
    const parent = createEnvelope({
      eventType: 'A',
      eventVersion: 1,
      producer: 'p',
      correlationId: uuidv7(),
      payload: {},
    });
    const child = childEnvelope(parent, {
      eventType: 'B',
      eventVersion: 1,
      producer: 'q',
      payload: { x: 1 },
    });
    expect(child.correlationId).toBe(parent.correlationId);
    expect(child.causationId).toBe(parent.eventId);
    expect(child.eventId).not.toBe(parent.eventId);
  });

  it('normalizes headers and keeps a valid incoming traceparent', () => {
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const headers = normalizeHeaders({
      traceparent: Buffer.from(tp),
      multi: ['a', Buffer.from('b')],
      gone: undefined,
    });
    expect(headers).toEqual({ traceparent: tp, multi: 'a,b' });
    expect(incomingTraceparent(headers)).toBe(tp);
    expect(incomingTraceparent({ traceparent: 'garbage' })).toMatch(/^00-[0-9a-f]{32}-/);
  });
});

describe('retryInProcess (SPEC §4.6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries transient failures after 100, 400 and 1600 ms', async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const attempt = vi.fn(() => {
      calls.push(Date.now());
      return calls.length < 4
        ? Promise.reject(new TransientError('db down'))
        : Promise.resolve('ok');
    });
    const result = retryInProcess(attempt, () => true);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('ok');
    expect(calls.slice(1).map((t, i) => t - (calls[i] ?? 0))).toEqual([100, 400, 1600]);
  });

  it('gives up after the last delay and stops early for non-retryable errors', async () => {
    vi.useFakeTimers();
    const always = vi.fn(() => Promise.reject(new TransientError('down')));
    const result = retryInProcess(always, () => true).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(TransientError);
    expect(always).toHaveBeenCalledTimes(4);

    const permanent = vi.fn(() => Promise.reject(new PermanentError('invariant', 'no')));
    await expect(retryInProcess(permanent, () => false)).rejects.toThrow('no');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('doubles the retry-topic delay per round', () => {
    expect([1, 2, 3, 4, 5].map((r) => retryRoundDelayMs(r, 1000))).toEqual([
      1000, 2000, 4000, 8000, 16000,
    ]);
  });
});

describe('consumerMetrics', () => {
  it('counts messages per outcome', async () => {
    const registry = createMetricsRegistry('svc', false);
    const metrics = consumerMetrics(registry);
    expect(consumerMetrics(registry)).toBe(metrics);
    for (const outcome of ['ok', 'ok', 'duplicate', 'retry', 'dlq'] as const) {
      metrics.messages.inc({ topic: 't', group: 'g', outcome });
    }
    const text = await registry.metrics();
    expect(text).toContain(
      'kafka_consumer_messages_total{topic="t",group="g",outcome="ok",service="svc"} 2',
    );
    expect(text).toContain('outcome="duplicate",service="svc"} 1');
    expect(text).toContain('outcome="dlq",service="svc"} 1');
  });
});
