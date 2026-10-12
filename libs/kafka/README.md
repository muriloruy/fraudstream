# @fraudstream/kafka

Kafka plumbing shared by every service (SPEC §4): the producer, topic admin helpers, and the
**consumer runtime** that turns Kafka's at-least-once delivery into effectively-once processing.
Built on `@confluentinc/kafka-javascript` (ADR-003).

## Producing

```ts
const kafka = createKafka({ brokers: parseBrokers(process.env.KAFKA_BROKERS), clientId: 'svc' });
const producer = createProducer(kafka); // acks=all, idempotent, lz4, linger 5 ms
```

Services do not publish business events directly: they write them to their outbox in the same DB
transaction as the change (`libs/outbox`, ADR-004).

## Consuming

```ts
import { ConsumerRuntime, on } from '@fraudstream/kafka';
import { FraudRulesEvaluated, AnomalyScored, FraudDecisionMade } from '@fraudstream/contracts';

const runtime = new ConsumerRuntime({
  kafka, pool, producer,
  group: 'decision-engine',
  schema: 'decision',                 // holds processed_events (pnpm migrations:add-inbox decision)
  registry,                           // Prometheus metrics (optional)
  logger,
  handlers: [
    on(FraudRulesEvaluated, async (event, ctx) => {
      await ctx.tx.query('...', [...]);                       // side effects: same DB transaction
      const decision = ctx.child({ eventType: FraudDecisionMade.eventType, eventVersion: 1,
                                   producer: 'decision-engine', payload });
      await outbox.write(ctx.tx, { topic: FraudDecisionMade.topic, key: event.payload.accountId,
                                   envelope: decision, traceparent: ctx.traceparent });
    }),
    on(AnomalyScored, async (event, ctx) => { /* ... */ }),
  ],
});
await runtime.start();
process.once('SIGTERM', () => void runtime.stop());
```

With NestJS, register it with `KafkaConsumerModule.forFeature({ name, useFactory })` from
`@fraudstream/kafka/nest` and enable `app.enableShutdownHooks()`; see
[`examples/consumer-app.ts`](examples/consumer-app.ts).

## What the runtime guarantees

For each message, in this order:

1. **Decode and validate** the envelope with the contracts schema chosen by `eventType` +
   `eventVersion`. Unknown fields are ignored (SPEC §4.10); invalid or unknown events are
   **permanent** failures.
2. **One DB transaction**: insert `(group, eventId)` into `<schema>.processed_events`
   (`ON CONFLICT DO NOTHING`); if the row already existed the event is a duplicate and the handler
   is skipped; otherwise run the handler, which writes its side effects and outbox rows through
   `ctx.tx`. Commit.
3. **Commit the Kafka offset** (`offset + 1`) only after the DB commit (`enable.auto.commit=false`).
   A crash between the two redelivers the message, and step 2 makes the redelivery a no-op.

| Failure                                                                                     | Handling                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient (DB connection, timeout, deadlock `40P01`, serialization `40001`, unknown errors) | Retried in process after 100 ms, 400 ms, 1.6 s; then published to `<topic>.<group>.retry` with `retry-count` and `retry-after` (1 s, 2 s, 4 s, ... per round); after 5 rounds, DLQ |
| Permanent (schema, unknown version, constraint violation, `PermanentError`)                 | Straight to `<topic>.<group>.dlq`                                                                                                                                                  |

The source offset is committed once the message has been rerouted, so **a poison message never
blocks its partition**. DLQ messages keep the original key, value and headers and add
`dlq-reason`, `dlq-error-message`, `original-topic`, `original-partition`, `original-offset`,
`failed-at`. Replay them with `pnpm dlq:replay` (see `docs/runbook.md`).

Retry-topic messages that are not due yet pause their partition and are re-read when due: no busy
loop, no sleeping inside the handler.

Other behaviour:

- **Range assignor by default**, so partition N of co-partitioned topics is owned by one instance
  (joins in `decision-engine`, ADR-002).
- **Rebalances** are logged (assigned / revoked partitions). Messages are processed one at a time
  per instance by default (`partitionsConsumedConcurrently: 1`), and librdkafka only rebalances
  between messages, so revocation never interrupts a handler.
- **Graceful shutdown** (`stop()`): pause every partition, finish and commit the in-flight
  message, leave the group.
- **Causation**: `ctx.child(...)` keeps the `correlationId` and sets `causationId` to the consumed
  `eventId`; `ctx.traceparent` carries the W3C trace context into the outbox (SPEC §4.8, §10).
- **Metrics**: `kafka_consumer_messages_total{topic,group,outcome="ok|duplicate|retry|dlq"}`,
  `kafka_consumer_processing_seconds{topic,group}`.
- **Inbox purge**: hourly, rows older than the longest retention of the consumed topics + 1 day.

## Ordering (SPEC §4.7)

- **Per account: guaranteed** — same key, same partition, idempotent producer, one message at a
  time per partition.
- **Across accounts: not guaranteed**, and not needed.
- **Retried messages lose their place**: while a message waits in the retry topic, later
  messages of the same account are processed. This is acceptable for fraud scoring (each
  transaction is evaluated on its own data plus aggregates) and keeps partitions flowing. A
  consumer that needs strict per-key order would instead pause the source partition and retry in
  place, trading throughput for order.

## Known issue: admin `fetchOffsets` inside test workers

Calling `admin.fetchOffsets()` for a consumer group that is active in the same process crashed
the Vitest worker (`SIGSEGV`, "Entering the V8 API without proper locking" in the binding's event
dispatcher). It does not happen in a plain Node process. Tests therefore read committed offsets
through the consumer itself (`ConsumerRuntime.committed()`), which uses the group coordinator.
