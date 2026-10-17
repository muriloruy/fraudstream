import {
  DlqHeaders,
  dlqTopic,
  EventHeaders,
  RetryHeaders,
  retryTopic,
  TOPIC_CATALOGUE,
  type Envelope,
} from '@fraudstream/contracts';
import { withTransaction, type Pool, type PoolClient } from '@fraudstream/db';
import {
  withConsumerSpan,
  withLogFields,
  type Logger,
  type Registry,
} from '@fraudstream/observability';
import confluent from '@confluentinc/kafka-javascript';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Kafka, Producer } from '../client.js';
import {
  childEnvelope,
  incomingTraceparent,
  normalizeHeaders,
  type ChildEventInput,
  type MessageHeaders,
} from './context.js';
import { decodeEvent, type EventDefinition } from './decode.js';
import { classifyError, describeError, PermanentError } from './errors.js';
import { Inbox } from './inbox.js';
import { consumerMetrics, OUTCOMES, type ConsumerMetrics, type Outcome } from './metrics.js';
import {
  IN_PROCESS_DELAYS_MS,
  MAX_RETRY_ROUNDS,
  retryInProcess,
  retryRoundDelayMs,
} from './retry.js';

const { PartitionAssigners } = confluent.KafkaJS;
type Consumer = KafkaJS.Consumer;
type KafkaMessage = KafkaJS.KafkaMessage;

/** librdkafka rebalance event codes (rd_kafka_resp_err_t). */
const ASSIGN_PARTITIONS = -175;
const REVOKE_PARTITIONS = -174;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface HandlerContext {
  /** The open DB transaction: write side effects and outbox rows through it. */
  tx: PoolClient;
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  headers: MessageHeaders;
  /** W3C trace context of the consumed message; pass it to the outbox writer. */
  traceparent: string;
  /** An envelope caused by the consumed event (same correlation id, causation = its id). */
  child<P>(input: ChildEventInput<P>): Envelope<P>;
  /**
   * Runs `fn` once the DB transaction has committed (not on rollback or retry), for in-process
   * side effects that must never announce uncommitted state, such as SSE pushes. Errors thrown
   * by `fn` are logged and do not affect the message.
   */
  afterCommit(fn: () => void): void;
}

export interface EventHandler {
  event: EventDefinition;
  handle(envelope: Envelope<unknown>, ctx: HandlerContext): Promise<void>;
}

/** Typed registration of a handler for one event definition. */
export function on<P>(
  event: EventDefinition<P>,
  handle: (envelope: Envelope<P>, ctx: HandlerContext) => Promise<void>,
): EventHandler {
  return {
    event: event,
    handle: (envelope, ctx) => handle(envelope as Envelope<P>, ctx),
  };
}

export type Assignor = 'range' | 'roundrobin' | 'cooperative-sticky';

export interface ConsumerRuntimeOptions {
  kafka: Kafka;
  pool: Pool;
  /** Used for retry and DLQ messages. */
  producer: Producer;
  group: string;
  /** Schema that holds this service's `processed_events` table. */
  schema: string;
  handlers: readonly EventHandler[];
  /**
   * Called for a message with a null value (a tombstone on a compacted topic), inside a DB
   * transaction. Without it, tombstones are invalid messages (DLQ).
   */
  onTombstone?: (key: string, tx: PoolClient, topic: string) => Promise<void>;
  /** Defaults to range: partition N of co-partitioned topics lands on one instance (ADR-002). */
  assignor?: Assignor;
  fromBeginning?: boolean;
  /** Delay of the first retry-topic round; doubles each round (default 1 s). */
  retryBaseDelayMs?: number;
  inProcessDelaysMs?: readonly number[];
  maxRetryRounds?: number;
  partitionsConsumedConcurrently?: number;
  sessionTimeoutMs?: number;
  maxPollIntervalMs?: number;
  /** processed_events rows older than this are purged (default: longest topic retention + 1 day). */
  inboxRetentionMs?: number;
  purgeIntervalMs?: number;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  registry?: Registry;
}

interface Delivery {
  topic: string;
  partition: number;
  message: KafkaMessage;
}

/**
 * Effectively-once message processing on top of at-least-once delivery (SPEC §4.3-§4.6).
 *
 * For every message: decode and validate the envelope, then in ONE database transaction
 * claim `(group, eventId)` in the inbox and run the handler (which writes its side effects
 * and outbox rows through the same transaction), commit, and only then commit the Kafka
 * offset. Transient failures are retried in process (100/400/1600 ms), then through
 * `<topic>.<group>.retry` (exponential `retry-after`, up to 5 rounds), then go to
 * `<topic>.<group>.dlq`; permanent failures go to the DLQ at once. The partition always keeps
 * flowing.
 */
export class ConsumerRuntime {
  private readonly consumer: Consumer;
  private readonly inbox: Inbox;
  private readonly handlers: Map<EventDefinition, EventHandler>;
  private readonly sourceTopics: string[];
  private readonly retryTopics: Map<string, string>;
  private readonly metrics: ConsumerMetrics | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly resumeTimers = new Set<NodeJS.Timeout>();
  private purgeTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private started = false;

  constructor(private readonly options: ConsumerRuntimeOptions) {
    this.inbox = new Inbox(options.schema);
    this.handlers = new Map(options.handlers.map((h) => [h.event, h]));
    this.sourceTopics = [...new Set(options.handlers.map((h) => h.event.topic))];
    this.retryTopics = new Map(this.sourceTopics.map((t) => [retryTopic(t, options.group), t]));
    this.metrics = options.registry ? consumerMetrics(options.registry) : undefined;
    // Export every outcome at 0 from the start: `increase()` cannot see a series' first sample,
    // so a counter born at 1 (the first DLQ message) would never show up in rates or alerts.
    for (const topic of this.sourceTopics) {
      for (const outcome of OUTCOMES)
        this.metrics?.messages.inc({ topic, group: options.group, outcome }, 0);
    }

    this.consumer = options.kafka.consumer({
      kafkaJS: {
        groupId: options.group,
        fromBeginning: options.fromBeginning ?? true,
        // Offsets are committed by hand, after the DB transaction commits (SPEC §4.3).
        autoCommit: false,
        sessionTimeout: options.sessionTimeoutMs ?? 30_000,
        partitionAssigners: [PartitionAssigners[assignorKey(options.assignor ?? 'range')]],
      },
      'max.poll.interval.ms': options.maxPollIntervalMs ?? 300_000,
      'isolation.level': 'read_committed',
      rebalance_cb: (
        error: { code: number },
        assignment: { topic: string; partition: number }[],
      ) => {
        this.logRebalance(error.code, assignment);
      },
    });
  }

  get group(): string {
    return this.options.group;
  }

  /** Partitions currently owned by this instance. */
  assignment(): { topic: string; partition: number }[] {
    return this.consumer.assignment().map(({ topic, partition }) => ({ topic, partition }));
  }

  /**
   * Committed offsets of this group for the given partitions, read through the group
   * coordinator by this consumer. (Admin `fetchOffsets` on an active group crashed the native
   * binding inside test workers; see libs/kafka/README.md.)
   */
  async committed(topic: string, partitions: readonly number[]): Promise<Map<number, string>> {
    const offsets = await this.consumer.committed(
      partitions.map((partition) => ({ topic, partition })),
    );
    return new Map(offsets.map((o) => [o.partition, o.offset]));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [...this.sourceTopics, ...this.retryTopics.keys()] });
    await this.consumer.run({
      partitionsConsumedConcurrently: this.options.partitionsConsumedConcurrently ?? 1,
      eachMessage: (payload) => this.track(this.deliver(payload)),
    });
    const retention = this.options.inboxRetentionMs ?? this.defaultInboxRetentionMs();
    this.purgeTimer = setInterval(
      () => {
        void this.purgeInbox(retention);
      },
      this.options.purgeIntervalMs ?? 60 * 60 * 1000,
    );
    this.purgeTimer.unref();
  }

  /**
   * Graceful shutdown (SPEC §4.3): stop taking new messages, let the in-flight one finish and
   * commit, then leave the group.
   */
  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    clearInterval(this.purgeTimer);
    for (const timer of this.resumeTimers) clearTimeout(timer);
    this.resumeTimers.clear();
    const assigned = this.consumer.assignment();
    if (assigned.length > 0) {
      this.consumer.pause(groupByTopic(assigned));
    }
    await Promise.allSettled([...this.inFlight]);
    await this.consumer.disconnect();
  }

  /** Deletes inbox rows older than `retentionMs`. Runs hourly; exposed for tests and ops. */
  async purgeInbox(retentionMs: number): Promise<number> {
    try {
      return await this.inbox.purge(this.options.pool, retentionMs);
    } catch (error) {
      this.options.logger?.warn({ err: describeError(error) }, 'processed_events purge failed');
      return 0;
    }
  }

  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    return work.finally(() => this.inFlight.delete(work));
  }

  private async deliver({ topic, partition, message }: Delivery): Promise<void> {
    // During shutdown, leave the message uncommitted: it is redelivered to the next owner.
    if (this.stopping) return;
    const started = performance.now();
    const headers = normalizeHeaders(message.headers);
    const sourceTopic = this.retryTopics.get(topic) ?? topic;

    if (sourceTopic !== topic) {
      const due = Number(headers[RetryHeaders.retryAfter] ?? 0);
      if (due > Date.now()) {
        this.pauseUntil(topic, partition, message.offset, due);
        return;
      }
    }

    // One CONSUMER span per message, child of the producer's span (SPEC §10): the handler's
    // DB spans and the events it writes continue the transaction's trace.
    const outcome = await withConsumerSpan(
      `process ${sourceTopic}`,
      incomingTraceparent(headers),
      {
        'messaging.system': 'kafka',
        'messaging.operation.type': 'process',
        'messaging.destination.name': sourceTopic,
        'messaging.consumer.group.name': this.group,
        'messaging.destination.partition.id': String(partition),
        'messaging.kafka.offset': message.offset,
        ...(headers[EventHeaders.correlationId]
          ? { 'fraudstream.correlation_id': headers[EventHeaders.correlationId] }
          : {}),
      },
      async (traceparent): Promise<Outcome> => {
        try {
          return await this.process(topic, partition, message, headers, traceparent);
        } catch (error) {
          return this.reroute(sourceTopic, topic, partition, message, headers, error);
        }
      },
    );

    await this.commit(topic, partition, message.offset);
    this.metrics?.messages.inc({ topic: sourceTopic, group: this.group, outcome });
    this.metrics?.processing.observe(
      { topic: sourceTopic, group: this.group },
      (performance.now() - started) / 1000,
    );
  }

  private async process(
    topic: string,
    partition: number,
    message: KafkaMessage,
    headers: MessageHeaders,
    spanTraceparent: string | undefined,
  ): Promise<Outcome> {
    const onTombstone = this.options.onTombstone;
    if (message.value === null && message.key !== null && onTombstone) {
      const key = message.key.toString();
      // Deleting state by key is idempotent, so tombstones need no inbox entry.
      await withTransaction(this.options.pool, (tx) => onTombstone(key, tx, topic));
      return 'ok';
    }
    const { definition, envelope } = decodeEvent(message.value, [...this.handlers.keys()]);
    const handler = this.handlers.get(definition);
    if (!handler)
      throw new PermanentError('unknown-event', `no handler for ${definition.eventType}`);
    const traceparent = spanTraceparent ?? incomingTraceparent(headers);
    const { transactionId } = envelope.payload as { transactionId?: unknown };

    return withLogFields(
      {
        correlationId: envelope.correlationId,
        ...(typeof transactionId === 'string' ? { transactionId } : {}),
      },
      () =>
        this.handleWithRetries(handler, envelope, topic, partition, message, headers, traceparent),
    );
  }

  private handleWithRetries(
    handler: EventHandler,
    envelope: Envelope<unknown>,
    topic: string,
    partition: number,
    message: KafkaMessage,
    headers: MessageHeaders,
    traceparent: string,
  ): Promise<Outcome> {
    return retryInProcess(
      async () => {
        const committed: (() => void)[] = []; // fresh per attempt: a retried attempt's hooks never run
        const outcome = await withTransaction(this.options.pool, async (tx): Promise<Outcome> => {
          if (!(await this.inbox.claim(tx, this.group, envelope.eventId))) return 'duplicate';
          await handler.handle(envelope, {
            tx,
            topic,
            partition,
            offset: message.offset,
            key: message.key?.toString() ?? null,
            headers,
            traceparent,
            child: (input) => childEnvelope(envelope, input),
            afterCommit: (fn) => committed.push(fn),
          });
          return 'ok';
        });
        for (const fn of committed) {
          try {
            fn();
          } catch (error) {
            this.options.logger?.warn({ err: describeError(error) }, 'afterCommit hook failed');
          }
        }
        return outcome;
      },
      (error) => classifyError(error) === 'transient',
      this.options.inProcessDelaysMs ?? IN_PROCESS_DELAYS_MS,
    );
  }

  /**
   * After in-process retries: the next retry round, or the DLQ. Throws only if Kafka refuses
   * the reroute, in which case the offset is not committed and the message comes back.
   */
  private async reroute(
    sourceTopic: string,
    topic: string,
    partition: number,
    message: KafkaMessage,
    headers: MessageHeaders,
    error: unknown,
  ): Promise<Outcome> {
    const origin: MessageHeaders = {
      [DlqHeaders.originalTopic]: headers[DlqHeaders.originalTopic] ?? sourceTopic,
      [DlqHeaders.originalPartition]: headers[DlqHeaders.originalPartition] ?? String(partition),
      [DlqHeaders.originalOffset]: headers[DlqHeaders.originalOffset] ?? message.offset,
    };
    const rounds = Number(headers[RetryHeaders.retryCount] ?? 0);
    const permanent = classifyError(error) === 'permanent';
    const maxRounds = this.options.maxRetryRounds ?? MAX_RETRY_ROUNDS;

    if (!permanent && rounds < maxRounds) {
      const round = rounds + 1;
      const due = Date.now() + retryRoundDelayMs(round, this.options.retryBaseDelayMs ?? 1000);
      await this.options.producer.send({
        topic: retryTopic(sourceTopic, this.group),
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              ...headers,
              ...origin,
              [RetryHeaders.retryCount]: String(round),
              [RetryHeaders.retryAfter]: String(due),
            },
          },
        ],
      });
      this.options.logger?.warn(
        { topic, partition, offset: message.offset, round, err: describeError(error) },
        'message scheduled for retry',
      );
      return 'retry';
    }

    const reason =
      error instanceof PermanentError
        ? error.reason
        : permanent
          ? 'invariant'
          : 'retries-exhausted';
    await this.options.producer.send({
      topic: dlqTopic(sourceTopic, this.group),
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            ...headers,
            ...origin,
            [DlqHeaders.reason]: reason,
            [DlqHeaders.errorMessage]: describeError(error),
            [DlqHeaders.failedAt]: new Date().toISOString(),
          },
        },
      ],
    });
    this.options.logger?.error(
      { topic, partition, offset: message.offset, reason, err: describeError(error) },
      'message sent to DLQ',
    );
    return 'dlq';
  }

  /**
   * Commits `offset + 1`. Coordinator changes ("Not coordinator") are retried; if the commit
   * still fails the message will simply be redelivered, which the inbox makes harmless.
   */
  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    const next = (BigInt(offset) + 1n).toString();
    try {
      await retryInProcess(
        () => this.consumer.commitOffsets([{ topic, partition, offset: next }]),
        () => !this.stopping,
        [100, 400, 1600],
      );
    } catch (error) {
      this.options.logger?.warn(
        { topic, partition, offset, err: describeError(error) },
        'offset commit failed; the message may be redelivered (deduplicated by the inbox)',
      );
    }
  }

  /** Pauses a retry partition until the message is due, then re-reads it from its offset. */
  private pauseUntil(topic: string, partition: number, offset: string, due: number): void {
    this.consumer.pause([{ topic, partitions: [partition] }]);
    this.consumer.seek({ topic, partition, offset });
    const timer = setTimeout(() => {
      this.resumeTimers.delete(timer);
      if (!this.stopping) this.consumer.resume([{ topic, partitions: [partition] }]);
    }, due - Date.now());
    this.resumeTimers.add(timer);
  }

  private logRebalance(code: number, assignment: { topic: string; partition: number }[]): void {
    const partitions = assignment.map((p) => `${p.topic}[${p.partition}]`);
    if (code === ASSIGN_PARTITIONS) {
      this.options.logger?.info({ group: this.group, partitions }, 'partitions assigned');
    } else if (code === REVOKE_PARTITIONS) {
      this.options.logger?.info({ group: this.group, partitions }, 'partitions revoked');
    }
  }

  private defaultInboxRetentionMs(): number {
    const retentions = TOPIC_CATALOGUE.filter((t) => this.sourceTopics.includes(t.name)).map(
      (t) => t.retentionMs ?? 30 * DAY_MS,
    );
    return Math.max(30 * DAY_MS, ...retentions) + DAY_MS;
  }
}

function assignorKey(assignor: Assignor): 'range' | 'roundRobin' | 'cooperativeSticky' {
  if (assignor === 'roundrobin') return 'roundRobin';
  if (assignor === 'cooperative-sticky') return 'cooperativeSticky';
  return 'range';
}

function groupByTopic(
  assignment: readonly { topic: string; partition: number }[],
): { topic: string; partitions: number[] }[] {
  const byTopic = new Map<string, number[]>();
  for (const { topic, partition } of assignment) {
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), partition]);
  }
  return [...byTopic].map(([topic, partitions]) => ({ topic, partitions }));
}
