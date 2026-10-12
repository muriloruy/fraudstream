import { randomBytes } from 'node:crypto';
import { EventHeaders, type Envelope } from '@fraudstream/contracts';

/** A new W3C `traceparent` (version 00, sampled). OTel replaces this with the active span in M7. */
export function newTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

/** The standard headers every message carries (SPEC §4.2). */
export function eventHeaders(
  envelope: Envelope<unknown>,
  traceparent: string = newTraceparent(),
): Record<string, string> {
  return {
    [EventHeaders.eventId]: envelope.eventId,
    [EventHeaders.eventType]: envelope.eventType,
    [EventHeaders.eventVersion]: String(envelope.eventVersion),
    [EventHeaders.correlationId]: envelope.correlationId,
    [EventHeaders.causationId]: envelope.causationId ?? '',
    [EventHeaders.traceparent]: traceparent,
    [EventHeaders.producer]: envelope.producer,
  };
}
