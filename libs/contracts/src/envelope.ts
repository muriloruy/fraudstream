import { z } from 'zod';
import { Uuid, UuidV7, UtcDateTime } from './primitives.js';
import { uuidv7 } from './uuid.js';

const envelopeFields = {
  eventId: UuidV7,
  eventType: z.string().min(1),
  eventVersion: z.number().int().positive(),
  occurredAt: UtcDateTime,
  producer: z.string().min(1),
  correlationId: Uuid,
  causationId: Uuid.nullable(),
};

/** Envelope shared by every event (SPEC §4.8). */
export const EventEnvelope = <T extends z.ZodType>(payload: T) =>
  z.object({ ...envelopeFields, payload });

export interface Envelope<P> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  producer: string;
  correlationId: string;
  causationId: string | null;
  payload: P;
}

export interface CreateEnvelopeInput<P> {
  eventType: string;
  eventVersion: number;
  producer: string;
  correlationId: string;
  causationId?: string | null;
  payload: P;
  now?: Date;
}

/** Builds an envelope with a fresh UUIDv7 `eventId` and a UTC `occurredAt`. */
export function createEnvelope<P>(input: CreateEnvelopeInput<P>): Envelope<P> {
  const now = input.now ?? new Date();
  return {
    eventId: uuidv7(now.getTime()),
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    occurredAt: now.toISOString(),
    producer: input.producer,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    payload: input.payload,
  };
}
