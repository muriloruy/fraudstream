import { describe, expect, it } from 'vitest';
import { backoffMs, groupByTopic, nextDelayMs, type OutboxRow } from './relay.js';

const row = (id: string, topic: string, key: string): OutboxRow => ({
  id,
  topic,
  message_key: key,
  payload: `{"id":${id}}`,
  headers: { 'event-id': id },
});

describe('groupByTopic', () => {
  it('keeps outbox order within each topic', () => {
    const groups = groupByTopic([
      row('1', 'a', 'k1'),
      row('2', 'b', 'k1'),
      row('3', 'a', 'k2'),
      row('4', 'a', 'k1'),
    ]);
    expect([...groups.keys()]).toEqual(['a', 'b']);
    expect(groups.get('a')?.map((m) => m.value)).toEqual(['{"id":1}', '{"id":3}', '{"id":4}']);
    expect(groups.get('b')?.[0]).toEqual({
      key: 'k1',
      value: '{"id":2}',
      headers: { 'event-id': '2' },
    });
  });
});

describe('backoffMs', () => {
  it('doubles from the poll interval up to the cap', () => {
    expect([0, 1, 2, 3, 4, 5].map((a) => backoffMs(a, 100, 2000))).toEqual([
      100, 200, 400, 800, 1600, 2000,
    ]);
  });
});

describe('nextDelayMs', () => {
  const options = { batchSize: 500, pollMs: 100, maxBackoffMs: 2000 };

  it('keeps polling at pollMs while idle, however long the quiet spell', () => {
    expect(nextDelayMs(0, 0, options)).toBe(100);
  });

  it('goes again immediately after a full batch', () => {
    expect(nextDelayMs(500, 0, options)).toBe(0);
    expect(nextDelayMs(499, 0, options)).toBe(100);
  });

  it('backs off exponentially only on consecutive failures', () => {
    expect([1, 2, 3, 4, 5, 6].map((f) => nextDelayMs(0, f, options))).toEqual([
      100, 200, 400, 800, 1600, 2000,
    ]);
  });
});
