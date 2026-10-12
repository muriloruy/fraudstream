import { EventEnvelope } from '@fraudstream/contracts';
import { z } from 'zod';
import type { EventDefinition } from '../consumer/decode.js';

export const TestPayload = z.object({ key: z.string(), n: z.number().int() });
export type TestPayload = z.infer<typeof TestPayload>;

/** A throwaway event bound to its own topic, so each test runs on an isolated stream. */
export function testEvent(topic: string): EventDefinition<TestPayload> {
  return {
    eventType: 'TestHappened',
    eventVersion: 1,
    topic,
    envelope: EventEnvelope(TestPayload),
  };
}
