import { createEnvelope, uuidv7 } from '@fraudstream/contracts';
import { describe, expect, it } from 'vitest';
import { assertSchemaName, OutboxWriter } from './index.js';

describe('OutboxWriter', () => {
  it('inserts the envelope and the standard headers as parameters', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve();
      },
    };
    const envelope = createEnvelope({
      eventType: 'Test',
      eventVersion: 1,
      producer: 'svc',
      correlationId: uuidv7(),
      payload: { a: 1 },
    });
    await new OutboxWriter('payments').write(client, {
      topic: 'payments.transactions.v1',
      key: 'acc_1',
      envelope,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('INSERT INTO payments.outbox');
    const [eventId, topic, key, payload, headers] = calls[0]?.params ?? [];
    expect([eventId, topic, key]).toEqual([envelope.eventId, 'payments.transactions.v1', 'acc_1']);
    expect(JSON.parse(payload as string)).toEqual(envelope);
    expect(JSON.parse(headers as string)).toMatchObject({
      'event-id': envelope.eventId,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
  });

  it('rejects schema names that are not plain identifiers', () => {
    expect(() => assertSchemaName('payments; DROP TABLE x')).toThrow(RangeError);
    expect(() => new OutboxWriter('Payments')).toThrow(RangeError);
    expect(assertSchemaName('fraud_rules')).toBe('fraud_rules');
  });
});
