import type { Envelope } from '@fraudstream/contracts';
import { eventHeaders } from '@fraudstream/kafka';
import { assertSchemaName } from './schema.js';

/** Anything that can run a parameterized query: a pg Pool or a transaction's client. */
export interface Queryable {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

export interface OutboxEvent {
  topic: string;
  /** Kafka message key; `accountId` for every fraud-flow topic (ADR-002). */
  key: string;
  envelope: Envelope<unknown>;
  traceparent?: string;
}

/**
 * Writes events to `<schema>.outbox`. Call it with the same client that writes the business
 * rows, inside one DB transaction: the event exists if and only if the change does (SPEC §4.5).
 */
export class OutboxWriter {
  private readonly insertSql: string;

  constructor(schema: string) {
    this.insertSql = `INSERT INTO ${assertSchemaName(schema)}.outbox
      (event_id, topic, message_key, payload, headers) VALUES ($1, $2, $3, $4, $5)`;
  }

  async write(client: Queryable, event: OutboxEvent): Promise<void> {
    await client.query(this.insertSql, [
      event.envelope.eventId,
      event.topic,
      event.key,
      JSON.stringify(event.envelope),
      JSON.stringify(eventHeaders(event.envelope, event.traceparent)),
    ]);
  }
}
