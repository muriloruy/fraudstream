import { EventHeaders } from '@fraudstream/contracts';
import type { Pool, PoolClient } from '@fraudstream/db';
import { sendMessages, type OutgoingMessage, type Producer } from '@fraudstream/kafka';
import { recordError, startProducerSpan, type Logger, type Span } from '@fraudstream/observability';
import type { RelayMetrics } from './metrics.js';
import { assertSchemaName } from './schema.js';

export interface OutboxRow {
  id: string;
  topic: string;
  message_key: string;
  payload: string;
  headers: Record<string, string>;
}

export interface RelayOptions {
  pool: Pool;
  producer: Producer;
  schema: string;
  /** Rows per cycle (`RELAY_BATCH_SIZE`, default 500). */
  batchSize?: number;
  /** Poll interval while there is work (`RELAY_POLL_MS`, default 100). */
  pollMs?: number;
  /** Upper bound of the exponential backoff after failed cycles (default 2000). */
  maxBackoffMs?: number;
  /** How often a standby instance retries to become leader (default 1000). */
  standbyRetryMs?: number;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  metrics?: RelayMetrics;
}

/**
 * Groups rows by topic, keeping outbox (id) order inside each topic. Order across topics does
 * not matter; order inside a topic is what preserves per-key order on its partitions.
 */
export function groupByTopic(rows: readonly OutboxRow[]): Map<string, OutgoingMessage[]> {
  const groups = new Map<string, OutgoingMessage[]>();
  for (const row of rows) {
    const messages = groups.get(row.topic) ?? [];
    messages.push({ key: row.message_key, value: row.payload, headers: row.headers });
    groups.set(row.topic, messages);
  }
  return groups;
}

/** Exponential backoff: pollMs, 2x, 4x, ... capped at maxMs. */
export function backoffMs(attempt: number, pollMs: number, maxMs: number): number {
  return Math.min(maxMs, pollMs * 2 ** Math.max(0, attempt));
}

/**
 * Delay before the next cycle. An idle relay keeps polling at `pollMs` (SPEC §6.3): backing
 * off while idle would add up to `maxMs` to every hop of the first event after a quiet spell,
 * and a decision crosses three relays. Only consecutive failures back off exponentially.
 */
export function nextDelayMs(
  published: number,
  failures: number,
  options: { batchSize: number; pollMs: number; maxBackoffMs: number },
): number {
  if (failures > 0) return backoffMs(failures - 1, options.pollMs, options.maxBackoffMs);
  // A full batch means there is probably more: go again immediately.
  return published >= options.batchSize ? 0 : options.pollMs;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Publishes `<schema>.outbox` rows to Kafka (SPEC §4.5).
 *
 * Each cycle locks the oldest unpublished rows with `FOR UPDATE SKIP LOCKED`, publishes them
 * with the idempotent producer, waits for the acks, then marks them published in the same DB
 * transaction. If publishing fails the rows stay unpublished, `attempts`/`last_error` are
 * recorded and the relay backs off. A crash between the acks and the commit republishes the
 * batch: delivery is at least once and consumers deduplicate by `event-id` (SPEC §4.4).
 *
 * Several instances may run: a session-level advisory lock elects one active publisher per
 * schema, so two batches of the same key can never be published concurrently and out of
 * order. The others stand by and take over when the leader's connection goes away.
 */
export class OutboxRelay {
  private readonly selectSql: string;
  private readonly markPublishedSql: string;
  private readonly markFailedSql: string;
  private readonly lockKey: string;
  private readonly batchSize: number;
  private readonly pollMs: number;
  private readonly maxBackoffMs: number;
  private readonly standbyRetryMs: number;
  private running = false;
  private loop: Promise<void> | undefined;
  private lockClient: PoolClient | undefined;
  private leader = false;

  constructor(private readonly options: RelayOptions) {
    const schema = assertSchemaName(options.schema);
    this.selectSql = `SELECT id, topic, message_key, payload::text AS payload, headers
        FROM ${schema}.outbox
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`;
    this.markPublishedSql = `UPDATE ${schema}.outbox SET published_at = now() WHERE id = ANY($1::bigint[])`;
    this.markFailedSql = `UPDATE ${schema}.outbox SET attempts = attempts + 1, last_error = left($2, 1000)
       WHERE id = ANY($1::bigint[])`;
    this.lockKey = `outbox-relay:${schema}`;
    this.batchSize = options.batchSize ?? 500;
    this.pollMs = options.pollMs ?? 100;
    this.maxBackoffMs = options.maxBackoffMs ?? 2000;
    this.standbyRetryMs = options.standbyRetryMs ?? 1000;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Stops after the in-flight batch, then releases leadership. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await this.releaseLeadership();
  }

  /** One publish cycle; returns the number of rows published. Exposed for tests. */
  async publishBatch(): Promise<number> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<OutboxRow>(this.selectSql, [this.batchSize]);
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }
      const ids = rows.map((r) => r.id);
      const started = performance.now();
      const { traced, spans } = withProducerSpans(rows);
      try {
        for (const [topic, messages] of groupByTopic(traced)) {
          await sendMessages(this.options.producer, topic, messages);
        }
      } catch (error) {
        for (const span of spans) recordError(span, error);
        await client.query(this.markFailedSql, [ids, describe(error)]);
        await client.query('COMMIT');
        throw error;
      } finally {
        for (const span of spans) span.end();
      }
      this.options.metrics?.publishDuration.observe(performance.now() - started);
      await client.query(this.markPublishedSql, [ids]);
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let published = 0;
      try {
        if (!(await this.ensureLeadership())) {
          await sleep(this.standbyRetryMs);
          continue;
        }
        published = await this.publishBatch();
        failures = 0;
      } catch (error) {
        failures++;
        this.options.logger?.warn({ err: describe(error) }, 'outbox publish failed; backing off');
      }
      const delay = nextDelayMs(published, failures, {
        batchSize: this.batchSize,
        pollMs: this.pollMs,
        maxBackoffMs: this.maxBackoffMs,
      });
      if (delay > 0) await sleep(delay);
    }
  }

  private async ensureLeadership(): Promise<boolean> {
    if (this.leader) return true;
    if (!this.lockClient) {
      this.lockClient = await this.options.pool.connect();
      // If the session dies, PostgreSQL releases the lock: stop acting as leader too.
      this.lockClient.on('error', () => {
        this.leader = false;
        this.lockClient?.release(true);
        this.lockClient = undefined;
      });
    }
    const { rows } = await this.lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [this.lockKey],
    );
    this.leader = rows[0]?.locked === true;
    if (this.leader)
      this.options.logger?.info({ schema: this.options.schema }, 'outbox relay is leader');
    return this.leader;
  }

  private async releaseLeadership(): Promise<void> {
    const client = this.lockClient;
    this.lockClient = undefined;
    if (!client) return;
    if (this.leader) {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [this.lockKey])
        .catch(() => undefined);
    }
    this.leader = false;
    client.release();
  }
}

/**
 * One PRODUCER span per row, child of the span that wrote the row (its stored `traceparent`);
 * the message carries the publish span instead, so consumers hang under it (SPEC §10).
 */
function withProducerSpans(rows: readonly OutboxRow[]): { traced: OutboxRow[]; spans: Span[] } {
  const spans: Span[] = [];
  const traced = rows.map((row) => {
    const { span, traceparent } = startProducerSpan(
      `publish ${row.topic}`,
      row.headers[EventHeaders.traceparent],
      {
        'messaging.system': 'kafka',
        'messaging.operation.type': 'send',
        'messaging.destination.name': row.topic,
        'messaging.kafka.message.key': row.message_key,
      },
    );
    spans.push(span);
    return traceparent
      ? { ...row, headers: { ...row.headers, [EventHeaders.traceparent]: traceparent } }
      : row;
  });
  return { traced, spans };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
