import { createEnvelope, EventHeaders, uuidv7 } from '@fraudstream/contracts';
import { describe, expect, it } from 'vitest';
import { eventHeaders, newTraceparent, parseBrokers } from './index.js';

describe('eventHeaders (SPEC §4.2)', () => {
  it('carries all seven standard headers derived from the envelope', () => {
    const envelope = createEnvelope({
      eventType: 'Test',
      eventVersion: 1,
      producer: 'svc',
      correlationId: uuidv7(),
      payload: {},
    });
    const headers = eventHeaders(envelope);
    expect(Object.keys(headers).sort()).toEqual(Object.values(EventHeaders).sort());
    expect(headers['event-id']).toBe(envelope.eventId);
    expect(headers['event-version']).toBe('1');
    expect(headers['causation-id']).toBe('');
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('generates distinct trace ids', () => {
    expect(newTraceparent()).not.toBe(newTraceparent());
  });
});

describe('parseBrokers', () => {
  it('splits and trims', () => {
    expect(parseBrokers(' a:1, b:2 ,')).toEqual(['a:1', 'b:2']);
    expect(() => parseBrokers('')).toThrow();
  });
});
