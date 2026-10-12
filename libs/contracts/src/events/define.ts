import type { z } from 'zod';
import { EventEnvelope } from '../envelope.js';
import type { TopicName } from '../topics.js';

/** Binds an event type to its version, topic and payload schema. */
export function defineEvent<const T extends string, P extends z.ZodType>(definition: {
  eventType: T;
  eventVersion: number;
  topic: TopicName;
  payload: P;
}) {
  return { ...definition, envelope: EventEnvelope(definition.payload) };
}
