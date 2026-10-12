import type { Envelope } from '@fraudstream/contracts';
import type { z } from 'zod';
import { PermanentError } from './errors.js';

/** What the runtime needs from a contracts event definition (`defineEvent(...)`). */
export interface EventDefinition<P = unknown> {
  eventType: string;
  eventVersion: number;
  topic: string;
  envelope: z.ZodType<Envelope<P>>;
}

/**
 * Parses a message value into a typed envelope. The definition is chosen by the envelope's
 * `eventType` and `eventVersion`; anything unknown or invalid is a permanent error (DLQ).
 * Consumer schemas strip unknown fields, so additive v1 changes never fail here (SPEC §4.10).
 */
export function decodeEvent(
  value: Buffer | string | null,
  definitions: readonly EventDefinition[],
): { definition: EventDefinition; envelope: Envelope<unknown> } {
  if (value === null) throw new PermanentError('schema-validation', 'message has no value');
  let raw: unknown;
  try {
    raw = JSON.parse(value.toString());
  } catch {
    throw new PermanentError('schema-validation', 'message value is not JSON');
  }
  const head = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    eventType?: unknown;
    eventVersion?: unknown;
  };
  const definition = definitions.find(
    (d) => d.eventType === head.eventType && d.eventVersion === head.eventVersion,
  );
  if (!definition) {
    throw new PermanentError(
      'unknown-event',
      `no handler for ${String(head.eventType)} v${String(head.eventVersion)}`,
    );
  }
  const parsed = definition.envelope.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new PermanentError('schema-validation', `invalid ${definition.eventType}: ${fields}`);
  }
  return { definition, envelope: parsed.data };
}
