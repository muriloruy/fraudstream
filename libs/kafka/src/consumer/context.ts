import { createEnvelope, EventHeaders, type Envelope } from '@fraudstream/contracts';
import { newTraceparent } from '../headers.js';

export type MessageHeaders = Record<string, string>;

/** Normalizes Kafka headers (Buffer / string / arrays) into plain strings. */
export function normalizeHeaders(
  headers: Record<string, Buffer | string | (Buffer | string)[] | undefined> | undefined,
): MessageHeaders {
  return Object.fromEntries(
    Object.entries(headers ?? {})
      .filter(
        (entry): entry is [string, Buffer | string | (Buffer | string)[]] => entry[1] !== undefined,
      )
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map((v) => v.toString()).join(',') : value.toString(),
      ]),
  );
}

/** W3C trace context carried from the consumed message to everything it causes. */
export function incomingTraceparent(headers: MessageHeaders): string {
  const value = headers[EventHeaders.traceparent];
  return value && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
    ? value
    : newTraceparent();
}

export interface ChildEventInput<P> {
  eventType: string;
  eventVersion: number;
  producer: string;
  payload: P;
}

/**
 * Builds an event caused by `parent`: same correlation id (the transaction id for the whole
 * flow) and `causationId` = the parent's `eventId` (SPEC §4.8).
 */
export function childEnvelope<P>(
  parent: Envelope<unknown>,
  input: ChildEventInput<P>,
): Envelope<P> {
  return createEnvelope({
    ...input,
    correlationId: parent.correlationId,
    causationId: parent.eventId,
  });
}
