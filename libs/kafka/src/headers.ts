import { randomBytes } from 'node:crypto';
import { EventHeaders, type Envelope } from '@fraudstream/contracts';
import { traceparentOf } from '@fraudstream/observability';

/**
 * The `traceparent` of the active span (an HTTP request, a consumed message), so what is
 * published continues its trace; a new random root (version 00, sampled) when there is none.
 */
export function newTraceparent(): string {
  return (
    traceparentOf() ?? `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
  );
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
