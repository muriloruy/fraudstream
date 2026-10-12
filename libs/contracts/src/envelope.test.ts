import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createEnvelope, EventEnvelope } from './envelope.js';
import { UuidV7 } from './primitives.js';
import { uuidv7 } from './uuid.js';

const Payload = z.object({ n: z.number() });
const Schema = EventEnvelope(Payload);
const correlationId = uuidv7();

describe('EventEnvelope (SPEC §4.8)', () => {
  it('parses an envelope built by createEnvelope', () => {
    const envelope = createEnvelope({
      eventType: 'Test',
      eventVersion: 1,
      producer: 'test',
      correlationId,
      payload: { n: 1 },
    });
    const parsed = Schema.parse(envelope);
    expect(parsed.payload.n).toBe(1);
    expect(parsed.causationId).toBeNull();
    expect(UuidV7.safeParse(parsed.eventId).success).toBe(true);
    expect(parsed.occurredAt.endsWith('Z')).toBe(true);
  });

  it('rejects an envelope without correlationId, naming the field', () => {
    const { correlationId: _omitted, ...rest } = createEnvelope({
      eventType: 'Test',
      eventVersion: 1,
      producer: 'test',
      correlationId,
      payload: { n: 1 },
    });
    const result = Schema.safeParse(rest);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('correlationId');
  });

  it.each([
    ['eventVersion', '1'],
    ['eventVersion', 1.5],
    ['eventId', 'not-a-uuid'],
    ['occurredAt', 'yesterday'],
    ['causationId', 'abc'],
  ])('rejects invalid %s = %j', (field, value) => {
    const envelope = {
      ...createEnvelope({
        eventType: 'Test',
        eventVersion: 1,
        producer: 'test',
        correlationId,
        payload: { n: 1 },
      }),
      [field]: value,
    };
    expect(Schema.safeParse(envelope).success).toBe(false);
  });

  it('rejects an invalid payload', () => {
    const envelope = createEnvelope({
      eventType: 'Test',
      eventVersion: 1,
      producer: 'test',
      correlationId,
      payload: { n: 'one' },
    });
    expect(Schema.safeParse(envelope).success).toBe(false);
  });
});

describe('uuidv7', () => {
  it('is time ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });
});
