# @fraudstream/contracts

Shared contracts for every producer and consumer (SPEC §4): the event envelope, v1 payload schemas (Zod), the topic catalogue, consumer group names and Kafka header names. It has no runtime dependency besides `zod`, so both NestJS services and the React app can use it.

## Envelope

Every event is wrapped in the same envelope (SPEC §4.8):

| Field           | Type                                              |
| --------------- | ------------------------------------------------- |
| `eventId`       | UUIDv7 (time ordered)                             |
| `eventType`     | e.g. `TransactionAuthorizationRequested`          |
| `eventVersion`  | integer, `1`                                      |
| `occurredAt`    | ISO 8601 UTC                                      |
| `producer`      | service name                                      |
| `correlationId` | UUID, the `transactionId` for the whole flow      |
| `causationId`   | UUID of the event that caused this one, or `null` |
| `payload`       | event-specific                                    |

```ts
import { createEnvelope, FraudDecisionMade, Topics } from '@fraudstream/contracts';

// Producer: build and validate before writing to the outbox.
const event = createEnvelope({
  eventType: FraudDecisionMade.eventType,
  eventVersion: FraudDecisionMade.eventVersion,
  producer: 'decision-engine',
  correlationId: transactionId,
  causationId: consumedEvent.eventId,
  payload,
});
FraudDecisionMade.envelope.parse(event);

// Consumer: unknown fields are stripped, never rejected.
const decision = FraudDecisionMade.envelope.parse(JSON.parse(message.value));
```

Valid examples of every event live in [`fixtures/`](fixtures) and are exercised by the unit tests; later milestones reuse them for contract tests (SPEC §13.3).

## Events (v1)

| Event                               | Topic                                                        |
| ----------------------------------- | ------------------------------------------------------------ |
| `TransactionAuthorizationRequested` | `payments.transactions.v1`                                   |
| `AccountProfileUpserted`            | `accounts.profiles.v1` (compacted; `null` value = tombstone) |
| `FraudRulesEvaluated`               | `fraud.rule-results.v1`                                      |
| `AnomalyScored`                     | `fraud.scores.v1`                                            |
| `FraudDecisionMade`                 | `fraud.decisions.v1`                                         |
| `LedgerEntriesPosted`               | `ledger.entries.v1`                                          |
| `AnalystFeedbackRecorded`           | `fraud.analyst-feedback.v1`                                  |

Built-in guarantees:

- **Money** is a decimal string with at most 2 decimals (`"1250.90"`); JSON numbers are rejected (ADR-009). Use `toCents()` for exact arithmetic.
- **No cardholder secrets**: there is no field for a PAN or CVV. `maskedPan` must be first 6 / last 4 (`411111******1111`), so a full PAN fails validation.
- **Hashed device data**: `ipHash` / `deviceIdHash` must be `sha256:<hex>`.
- **Ledger invariant**: `LedgerEntriesPosted` rejects journals whose debits and credits differ.

## Versioning rules (SPEC §4.10)

- Inside `v1` only backward-compatible changes are allowed: **add optional fields**.
- Consumers ignore unknown fields (schemas strip them; never use `.strict()` on the consumer side).
- A breaking change means a new `*.v2` topic and a new schema, with dual publishing during migration.

### Adding a field

1. Add it as `.optional()` to the payload schema in `src/events/<event>.ts`.
2. Add it to the fixture in `fixtures/` and a test for its validation.
3. Producers may start sending it immediately; consumers that need it must handle its absence.

## Topics

`src/topics.ts` is the topic catalogue (SPEC §4.1): partitions, retention, cleanup policy and consumer groups, plus `retryTopic()` / `dlqTopic()` name builders. `infra/kafka/topics.conf`, used by the `init-topics` container, is generated from it:

```bash
pnpm topics:generate
```

A unit test fails if `topics.conf` and the catalogue drift apart. All fraud-flow topics have 12 partitions; never change the partition count of an existing topic (ADR-002).
