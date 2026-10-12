# FraudStream — Real-Time Payment Fraud Detection Platform

> Technical specification for a portfolio project.
> Goal: demonstrate production-grade **Kafka**, **NestJS/TypeScript**, **PostgreSQL**, **React + Tailwind**, **secure coding (PCI DSS-inspired)** and **anomaly detection** in a single, runnable repository.

---

## 0. How to use this document

- This spec is the single source of truth for the project. Build it milestone by milestone (section 17); each milestone has acceptance criteria you can check off.
- Everything must run locally with `docker compose up` plus one seed command. No cloud account required.
- When working with Claude Code, put a short `CLAUDE.md` at the repo root (template in section 18) and point it to this file (`docs/SPEC.md`).
- Decisions that a reviewer might question are recorded as ADRs in `docs/adr/` (section 16). They double as interview material.

---

## 1. Context and goals

### 1.1 Problem
A card issuer receives a continuous stream of payment authorizations. Each transaction must be evaluated for fraud in near real time, using deterministic rules and a statistical anomaly score. Approved transactions are posted to a double-entry ledger. Suspicious ones go to an analyst queue in a web dashboard.

### 1.2 Goals
| # | Goal | Evidence in the repo |
|---|------|----------------------|
| G1 | Event-driven microservices on Kafka | 7 services communicating only through topics (plus one REST entry point) |
| G2 | Correct Kafka usage | Keyed partitioning, consumer groups, manual offset commit, idempotent consumers, retry + DLQ, transactional outbox, replay |
| G3 | Database engineering | Normalized schemas, partitioned tables, indexes justified by `EXPLAIN ANALYZE`, migrations |
| G4 | Secure coding | Card tokenization vault, AES-256-GCM, PAN never logged, RBAC, audit trail, input validation, rate limiting, SAST in CI |
| G5 | Fraud / anomaly detection | Rules engine + per-account EWMA anomaly scorer + decision fusion |
| G6 | Frontend from design | 4 screens designed in Figma and implemented in React + Tailwind |
| G7 | Operability | Tracing across Kafka, metrics, consumer lag, dashboards, load and chaos tests |

### 1.3 Non-goals
- Real PCI DSS certification (the README must state this is a demonstration).
- Real card networks, ISO 8583, 3-D Secure.
- Multi-region deployment, Kubernetes manifests (optional stretch).
- Training a deep learning model in v1 (LSTM autoencoder is a stretch goal, section 9.4).

---

## 2. Tech stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | TypeScript (strict mode) | `"strict": true`, `noUncheckedIndexedAccess: true` |
| Runtime | Node.js LTS (20+) | |
| Backend framework | NestJS (latest stable) | Modules, DI, guards, pipes, interceptors |
| Kafka client | `@confluentinc/kafka-javascript` (KafkaJS-compatible API) or KafkaJS | Check maintenance status of both before starting; record the choice in ADR-003 |
| Broker | Apache Kafka in KRaft mode (no ZooKeeper), 3 brokers in compose | 1 broker profile for low-RAM machines |
| Schemas | Zod contracts in a shared lib (v1); Confluent Schema Registry + Avro (stretch) | |
| Database | PostgreSQL 16+ | One instance, one schema per service (logical isolation) |
| ORM / SQL | Kysely or raw SQL via `pg` | Avoid heavy ORMs: the point is to show SQL skill. Migrations with `node-pg-migrate` or Kysely migrator |
| Cache / state | PostgreSQL only (v1); Redis optional | Keeping state in Postgres simplifies exactly-once reasoning |
| Frontend | React 18+, Vite, Tailwind CSS, TanStack Query, React Router | Recharts for charts |
| Realtime to browser | Server-Sent Events (SSE) | Simpler than WebSocket for one-way feeds; ADR-006 |
| Auth | JWT (access 15 min + refresh), argon2 password hashing | Roles: `analyst`, `admin` |
| Observability | OpenTelemetry, Prometheus, Grafana, Jaeger, pino logs | kafka-ui (Kafbat UI) for topic inspection |
| Tests | Jest/Vitest, Testcontainers, Playwright, k6 | |
| Monorepo | pnpm workspaces + Nx (or Turborepo) | |
| CI | GitHub Actions | lint, typecheck, unit, integration, CodeQL, dependency audit, Docker build |

---

## 3. Architecture

### 3.1 Services

| Service | Type | Responsibility | Consumes | Produces | DB schema |
|---------|------|----------------|----------|----------|-----------|
| `transaction-api` | NestJS HTTP | Receives authorization requests, validates, calls vault, persists transaction + outbox row atomically | — | (via outbox) `payments.transactions.v1` | `payments` |
| `card-vault` | NestJS HTTP (internal only) | Tokenizes PAN, stores it encrypted, returns token + masked PAN. The only component that ever sees a PAN | — | — | `vault` |
| `outbox-relay` | Node worker | Polls `payments.outbox`, publishes to Kafka, marks rows as sent | — | `payments.transactions.v1` | `payments` |
| `fraud-rules` | NestJS Kafka consumer | Evaluates deterministic rules using per-account state | `payments.transactions.v1`, `accounts.profiles.v1` | `fraud.rule-results.v1` | `fraud_rules` |
| `anomaly-scorer` | NestJS Kafka consumer | Per-account EWMA statistics, z-scores, anomaly score 0..1 | `payments.transactions.v1` | `fraud.scores.v1` | `anomaly` |
| `decision-engine` | NestJS Kafka consumer | Joins rule results + score per transaction, applies thresholds and overrides, handles timeouts | `fraud.rule-results.v1`, `fraud.scores.v1` | `fraud.decisions.v1` | `decision` |
| `ledger` | NestJS Kafka consumer | Posts double-entry entries for approved transactions, idempotently | `fraud.decisions.v1` | `ledger.entries.v1` | `ledger` |
| `alerts-gateway` | NestJS HTTP + consumer | Stores REVIEW/DECLINE alerts, analyst actions, REST + SSE for the web app, auth | `fraud.decisions.v1`, `ledger.entries.v1` | `fraud.analyst-feedback.v1` | `alerts`, `auth` |
| `simulator` | Node CLI | Generates realistic traffic with injected fraud patterns | — | HTTP calls to `transaction-api`; `accounts.profiles.v1` seed | — |
| `web` | React SPA | Analyst dashboard | REST + SSE from `alerts-gateway` | — | — |

### 3.2 Flow diagram (put a Mermaid copy in the README)

```mermaid
flowchart LR
  SIM[simulator] -->|POST /v1/transactions| API[transaction-api]
  API -->|tokenize| VAULT[card-vault]
  API -->|tx + outbox in one DB transaction| PG[(PostgreSQL)]
  RELAY[outbox-relay] -->|poll outbox| PG
  RELAY --> T1[[payments.transactions.v1]]
  T1 --> RULES[fraud-rules]
  T1 --> SCORER[anomaly-scorer]
  PROF[[accounts.profiles.v1 compacted]] --> RULES
  RULES --> T2[[fraud.rule-results.v1]]
  SCORER --> T3[[fraud.scores.v1]]
  T2 --> DEC[decision-engine]
  T3 --> DEC
  DEC --> T4[[fraud.decisions.v1]]
  T4 --> LEDGER[ledger]
  T4 --> ALERTS[alerts-gateway]
  LEDGER --> T5[[ledger.entries.v1]]
  T5 --> ALERTS
  ALERTS -->|REST + SSE| WEB[web React]
  ALERTS --> T6[[fraud.analyst-feedback.v1]]
  T6 --> SCORER
```

### 3.3 Transaction lifecycle
1. Client sends `POST /v1/transactions` with `Idempotency-Key`.
2. `transaction-api` validates input, checks Luhn, calls `card-vault` → receives `cardToken` and `maskedPan`. The PAN is discarded from memory right after the call.
3. In **one** PostgreSQL transaction: insert into `payments.transactions` (status `PENDING`) and `payments.outbox`. Return `202 Accepted` with `transactionId`.
4. `outbox-relay` publishes the event to `payments.transactions.v1` keyed by `accountId`.
5. `fraud-rules` and `anomaly-scorer` consume in parallel (different consumer groups) and publish their results, keyed by `accountId`.
6. `decision-engine` joins both results by `transactionId` and publishes a decision (`APPROVE`, `REVIEW`, `DECLINE`).
7. `ledger` posts entries for `APPROVE`. `alerts-gateway` stores `REVIEW`/`DECLINE` as alerts and pushes them to the browser via SSE.
8. `transaction-api` exposes `GET /v1/transactions/:id`, whose status is updated by a small consumer of `fraud.decisions.v1` inside `transaction-api` (same service owns its table).
9. An analyst resolves a `REVIEW` alert → `fraud.analyst-feedback.v1` → `anomaly-scorer` uses confirmed-legit feedback to update the account baseline.

### 3.4 Why asynchronous decisions
Real authorizations are synchronous with a hard timeout. Here the API returns `202` and the client polls or subscribes. This keeps the project focused on Kafka patterns. Document this trade-off in ADR-005, including how a synchronous variant would work (request/reply topic with correlation ID and 300 ms timeout).

---

## 4. Kafka design

### 4.1 Topics

| Topic | Key | Partitions | Replication | Retention / cleanup | Producer | Consumer groups |
|-------|-----|-----------|-------------|---------------------|----------|-----------------|
| `payments.transactions.v1` | `accountId` | 12 | 3 | 7 days, delete | outbox-relay | `fraud-rules`, `anomaly-scorer` |
| `accounts.profiles.v1` | `accountId` | 12 | 3 | compact | simulator (seed), future account service | `fraud-rules` |
| `fraud.rule-results.v1` | `accountId` | 12 | 3 | 3 days, delete | fraud-rules | `decision-engine` |
| `fraud.scores.v1` | `accountId` | 12 | 3 | 3 days, delete | anomaly-scorer | `decision-engine` |
| `fraud.decisions.v1` | `accountId` | 12 | 3 | 30 days, delete | decision-engine | `ledger`, `alerts-gateway`, `transaction-api-status` |
| `ledger.entries.v1` | `accountId` | 12 | 3 | 30 days, delete | ledger | `alerts-gateway` |
| `fraud.analyst-feedback.v1` | `accountId` | 6 | 3 | 30 days, delete | alerts-gateway | `anomaly-scorer` |
| `<topic>.<group>.retry` | same as source | same as source | 3 | 1 day | each consumer | same group |
| `<topic>.<group>.dlq` | same as source | 3 | 3 | 30 days | each consumer | none (manual replay) |

Rules:
- **All fraud topics use the same key (`accountId`) and the same partition count (12).** This co-partitioning guarantees that all events of one account land on the same partition number in every topic, which keeps per-account ordering and makes the join in `decision-engine` local to one consumer instance. Changing partition count later breaks this; document it in ADR-002.
- Topics are created by an `init-topics` container with explicit config (never rely on auto-create; set `auto.create.topics.enable=false`).
- Broker/topic config: `min.insync.replicas=2`, `unclean.leader.election.enable=false`.

### 4.2 Producer configuration
- `acks=all`, `enable.idempotence=true`, `max.in.flight.requests.per.connection<=5`, compression `lz4` or `zstd`.
- `linger.ms=5`, `batch.size` default (tune in the load test and record the result).
- Every message carries headers: `event-id`, `event-type`, `event-version`, `correlation-id`, `causation-id`, `traceparent` (W3C), `producer`.

### 4.3 Consumer configuration and processing loop
- `enable.auto.commit=false`. Offsets are committed **only after** the database transaction with the side effect commits.
- Use `eachBatch` with `resolveOffset` + `heartbeat` per message, or `eachMessage` for simplicity in v1; measure both in the load test.
- `isolation.level=read_committed` (needed if you adopt Kafka transactions in the stretch milestone).
- `session.timeout.ms=30000`, `max.poll.interval.ms` large enough for batch DB writes.
- Handle rebalances: log partition assignment/revocation, flush in-flight work on revoke.
- Graceful shutdown on `SIGTERM`: stop fetching, finish in-flight message, commit, disconnect.

### 4.4 Idempotent consumers (effectively-once processing)
Kafka delivers at least once. Each consumer guarantees idempotency with an inbox table in its own schema:

```sql
CREATE TABLE <schema>.processed_events (
  consumer_group text        NOT NULL,
  event_id       uuid        NOT NULL,
  processed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_group, event_id)
);
```

Processing algorithm:
```
BEGIN;
  INSERT INTO processed_events (consumer_group, event_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING RETURNING event_id;
  -- 0 rows returned → duplicate → COMMIT and skip side effects
  <apply side effects (state update, inserts)>
  <insert outgoing events into this service's outbox table>
COMMIT;
commit Kafka offset;
```
Every consumer that produces events uses **its own outbox** (`<schema>.outbox`) and a shared relay library, so "update DB + publish event" is atomic. Purge `processed_events` older than topic retention + 1 day with a scheduled job.

### 4.5 Transactional outbox

```sql
CREATE TABLE payments.outbox (
  id            bigserial    PRIMARY KEY,
  event_id      uuid         NOT NULL UNIQUE,
  topic         text         NOT NULL,
  message_key   text         NOT NULL,
  payload       jsonb        NOT NULL,
  headers       jsonb        NOT NULL DEFAULT '{}',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      int          NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_unpublished_idx ON payments.outbox (id) WHERE published_at IS NULL;
```

Relay loop (multiple relay instances must be safe):
```sql
SELECT id, topic, message_key, payload, headers
FROM payments.outbox
WHERE published_at IS NULL
ORDER BY id
LIMIT 500
FOR UPDATE SKIP LOCKED;
```
Publish the batch, wait for acks, then `UPDATE ... SET published_at = now() WHERE id = ANY($1)` and commit. Order per key is preserved because rows are read by `id` and published with the same key. Poll interval 100 ms, backoff when empty. Optional stretch: replace polling with Debezium CDC (ADR-007).

### 4.6 Retry and dead letter
- **Transient errors** (DB connection, timeout): in-process retry, 3 attempts, exponential backoff 100 ms → 400 ms → 1.6 s.
- Still failing: publish to `<topic>.<group>.retry` with header `retry-count` and `retry-after`. A retry consumer waits until `retry-after` and reprocesses. Max 5 retries.
- **Permanent errors** (schema validation failure, unknown event version, business invariant broken): publish straight to `<topic>.<group>.dlq`.
- DLQ message keeps the original payload, key and headers, plus `dlq-reason`, `dlq-error-message`, `original-topic`, `original-partition`, `original-offset`, `failed-at`.
- Replay: CLI `pnpm dlq:replay --topic <dlq> --from <offset> --to <offset> [--dry-run]` and an admin-only endpoint in `alerts-gateway`. Replays are safe because consumers are idempotent.
- Never block a partition indefinitely on one poison message.

### 4.7 Ordering guarantees (to document in README)
- Per account: guaranteed (same key → same partition, idempotent producer, single-threaded per partition processing).
- Across accounts: not guaranteed and not needed.
- Retry topic breaks strict per-account ordering for the retried message. Acceptable here; explain why and how to avoid it if needed (pause the partition instead of rerouting).

### 4.8 Event envelope
All events share this envelope (Zod schema in `libs/contracts`):

```ts
const EventEnvelope = <T extends z.ZodTypeAny>(payload: T) => z.object({
  eventId: z.string().uuid(),          // UUIDv7 (time-ordered)
  eventType: z.string(),               // e.g. "TransactionAuthorizationRequested"
  eventVersion: z.number().int(),      // 1
  occurredAt: z.string().datetime(),   // ISO 8601 UTC
  producer: z.string(),                // service name
  correlationId: z.string().uuid(),    // = transactionId for the whole flow
  causationId: z.string().uuid().nullable(), // eventId that caused this one
  payload,
});
```

### 4.9 Event payloads (v1)

**`payments.transactions.v1` — `TransactionAuthorizationRequested`**
```json
{
  "transactionId": "0192f1a2-...",
  "accountId": "acc_000123",
  "cardToken": "tok_9f8c...",
  "maskedPan": "411111******1111",
  "amount": { "value": "1250.90", "currency": "BRL" },
  "merchant": { "id": "mer_771", "name": "Loja Exemplo", "mcc": "5732", "country": "BR", "city": "São Paulo" },
  "channel": "ECOMMERCE",
  "entryMode": "CARD_NOT_PRESENT",
  "device": { "ipHash": "sha256:...", "deviceIdHash": "sha256:..." },
  "geo": { "lat": -23.55, "lon": -46.63 },
  "requestedAt": "2026-10-12T18:00:00.000Z"
}
```
- Money is a **decimal string**, never a float. Use `decimal.js` or integer cents internally; store `numeric(18,2)`.
- IP and device IDs are hashed (SHA-256 with a pepper) before leaving `transaction-api`.

**`fraud.rule-results.v1` — `FraudRulesEvaluated`**
```json
{
  "transactionId": "...",
  "accountId": "acc_000123",
  "ruleScore": 0.62,
  "hardDecline": false,
  "firedRules": [
    { "ruleId": "R001", "name": "velocity_1m", "points": 30, "details": { "countLast60s": 7, "threshold": 5 } }
  ],
  "rulesetVersion": "2026.10.1",
  "evaluatedAt": "..."
}
```

**`fraud.scores.v1` — `AnomalyScored`**
```json
{
  "transactionId": "...",
  "accountId": "acc_000123",
  "anomalyScore": 0.81,
  "features": { "amountZ": 4.2, "interArrivalZ": -2.1, "newMerchant": true, "hourOfDayDeviation": 0.7 },
  "baselineSampleSize": 143,
  "modelVersion": "ewma-1.0",
  "scoredAt": "..."
}
```

**`fraud.decisions.v1` — `FraudDecisionMade`**
```json
{
  "transactionId": "...",
  "accountId": "acc_000123",
  "decision": "REVIEW",
  "finalScore": 0.69,
  "components": { "ruleScore": 0.62, "anomalyScore": 0.81 },
  "reasons": ["R001 velocity_1m", "amount 4.2σ above baseline"],
  "partial": false,
  "decidedAt": "...",
  "latencyMs": 184
}
```

**`ledger.entries.v1` — `LedgerEntriesPosted`**
```json
{
  "transactionId": "...",
  "accountId": "acc_000123",
  "journalId": "...",
  "entries": [
    { "ledgerAccount": "customer:acc_000123", "direction": "DEBIT",  "amount": "1250.90", "currency": "BRL" },
    { "ledgerAccount": "merchant:mer_771",    "direction": "CREDIT", "amount": "1250.90", "currency": "BRL" }
  ],
  "postedAt": "..."
}
```

**`accounts.profiles.v1` — `AccountProfileUpserted`** (compacted; a `null` value = tombstone)
```json
{ "accountId": "acc_000123", "homeCountry": "BR", "homeCity": "São Paulo", "createdAt": "...", "riskTier": "LOW", "creditLimit": "8000.00" }
```

**`fraud.analyst-feedback.v1` — `AnalystFeedbackRecorded`**
```json
{ "transactionId": "...", "accountId": "...", "alertId": "...", "verdict": "CONFIRMED_FRAUD", "analystId": "usr_12", "note": "Customer confirmed card stolen", "recordedAt": "..." }
```

### 4.10 Schema evolution
- Only backward-compatible changes inside `v1` (add optional fields). Breaking change → new topic `*.v2` and dual-publish during migration.
- Consumers must ignore unknown fields (Zod `.passthrough()` or `.strip()`, never `.strict()` on consumers).
- Contract tests (section 13) fail CI if a producer emits something the consumer schema rejects.
- Stretch: Schema Registry with Avro, compatibility `BACKWARD`.

---

## 5. Data model (PostgreSQL)

General rules:
- One schema per service; each service connects with its own DB role that can only access its schema (shows least privilege).
- `timestamptz` everywhere, UTC.
- `numeric(18,2)` for money.
- UUIDv7 primary keys for time-ordered inserts (better B-tree locality than v4).
- Every index has a comment in the migration explaining which query it serves.
- Large append-only tables are range-partitioned by month.

### 5.1 `payments` (transaction-api)

```sql
CREATE TABLE payments.transactions (
  transaction_id   uuid          NOT NULL,
  account_id       text          NOT NULL,
  card_token       text          NOT NULL,
  masked_pan       char(16)      NOT NULL,
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  currency         char(3)       NOT NULL,
  merchant_id      text          NOT NULL,
  merchant_mcc     char(4)       NOT NULL,
  merchant_country char(2)       NOT NULL,
  channel          text          NOT NULL CHECK (channel IN ('ECOMMERCE','POS','ATM')),
  status           text          NOT NULL CHECK (status IN ('PENDING','APPROVED','REVIEW','DECLINED')),
  final_score      numeric(5,4),
  requested_at     timestamptz   NOT NULL,
  decided_at       timestamptz,
  PRIMARY KEY (transaction_id, requested_at)
) PARTITION BY RANGE (requested_at);

-- monthly partitions created by a migration helper / pg_partman
-- Query: account history screen, newest first
CREATE INDEX tx_account_time_idx ON payments.transactions (account_id, requested_at DESC);
-- Query: "pending older than N seconds" health check
CREATE INDEX tx_pending_idx ON payments.transactions (requested_at) WHERE status = 'PENDING';

CREATE TABLE payments.idempotency_keys (
  idempotency_key text        PRIMARY KEY,
  request_hash    char(64)    NOT NULL,   -- sha256 of canonical request body
  response_status int         NOT NULL,
  response_body   jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- same key + different body → 422; same key + same body → stored response
```

### 5.2 `vault` (card-vault)

```sql
CREATE TABLE vault.cards (
  card_token     text        PRIMARY KEY,           -- 'tok_' + 32 random bytes base62
  pan_ciphertext bytea       NOT NULL,              -- AES-256-GCM
  pan_iv         bytea       NOT NULL,              -- 12 bytes, unique per row
  pan_auth_tag   bytea       NOT NULL,
  pan_hmac       char(64)    NOT NULL UNIQUE,       -- HMAC-SHA256(pan, hmacKey) for dedup lookup
  key_version    int         NOT NULL,              -- supports key rotation
  bin            char(6)     NOT NULL,
  last4          char(4)     NOT NULL,
  expiry_month   smallint    NOT NULL,
  expiry_year    smallint    NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- No index on ciphertext. Lookup by pan_hmac only.
```
CVV is **never stored**, not even encrypted (mirrors PCI DSS requirement 3.3.1).

### 5.3 `fraud_rules`

```sql
CREATE TABLE fraud_rules.account_profiles (       -- materialized from compacted topic
  account_id   text PRIMARY KEY,
  home_country char(2) NOT NULL,
  home_city    text,
  risk_tier    text NOT NULL,
  credit_limit numeric(18,2) NOT NULL,
  updated_at   timestamptz NOT NULL
);

CREATE TABLE fraud_rules.account_activity (       -- sliding-window source
  account_id     text          NOT NULL,
  transaction_id uuid          NOT NULL,
  amount         numeric(18,2) NOT NULL,
  merchant_id    text          NOT NULL,
  country        char(2)       NOT NULL,
  geo_lat        numeric(8,5),
  geo_lon        numeric(8,5),
  occurred_at    timestamptz   NOT NULL,
  PRIMARY KEY (account_id, occurred_at, transaction_id)
);
-- PK order (account_id, occurred_at) serves all window queries:
-- SELECT count(*) FROM account_activity WHERE account_id=$1 AND occurred_at > $2 - interval '60 seconds'

CREATE TABLE fraud_rules.known_merchants (account_id text, merchant_id text, first_seen timestamptz, PRIMARY KEY (account_id, merchant_id));
CREATE TABLE fraud_rules.blocklist (kind text CHECK (kind IN ('MERCHANT','MCC','BIN')), value text, reason text, created_at timestamptz DEFAULT now(), PRIMARY KEY (kind, value));
CREATE TABLE fraud_rules.processed_events (...);  -- section 4.4
CREATE TABLE fraud_rules.outbox (...);            -- section 4.5
```
Cleanup job deletes `account_activity` older than 30 days (or partition by day and drop partitions: show both and benchmark in `docs/perf.md`).

### 5.4 `anomaly`

```sql
CREATE TABLE anomaly.account_baselines (
  account_id          text PRIMARY KEY,
  n                   int           NOT NULL,
  amount_ewma         double precision NOT NULL,
  amount_ewm_var      double precision NOT NULL,
  interarrival_ewma   double precision NOT NULL,   -- seconds
  interarrival_ewm_var double precision NOT NULL,
  hour_histogram      int[]         NOT NULL,       -- 24 buckets
  last_tx_at          timestamptz   NOT NULL,
  model_version       text          NOT NULL,
  updated_at          timestamptz   NOT NULL
);
```
Updates use `SELECT ... FOR UPDATE` inside the idempotent transaction. Because the key is `accountId`, only one consumer instance touches a given account, so contention is near zero; explain this in the README.

### 5.5 `decision`

```sql
CREATE TABLE decision.pending (
  transaction_id uuid PRIMARY KEY,
  account_id     text NOT NULL,
  rule_result    jsonb,
  anomaly_score  jsonb,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  deadline_at    timestamptz NOT NULL                -- first_seen_at + 2 s
);
CREATE INDEX pending_deadline_idx ON decision.pending (deadline_at);

CREATE TABLE decision.decisions (
  transaction_id uuid PRIMARY KEY,
  account_id     text NOT NULL,
  decision       text NOT NULL,
  final_score    numeric(5,4) NOT NULL,
  rule_score     numeric(5,4),
  anomaly_score  numeric(5,4),
  partial        boolean NOT NULL,
  reasons        text[] NOT NULL,
  config_version text NOT NULL,
  decided_at     timestamptz NOT NULL
);
CREATE INDEX decisions_account_time_idx ON decision.decisions (account_id, decided_at DESC);
```

### 5.6 `ledger`

```sql
CREATE TABLE ledger.journals (
  journal_id     uuid PRIMARY KEY,
  transaction_id uuid NOT NULL UNIQUE,              -- idempotency at business level
  posted_at      timestamptz NOT NULL
);

CREATE TABLE ledger.entries (
  entry_id       bigserial PRIMARY KEY,
  journal_id     uuid NOT NULL REFERENCES ledger.journals,
  ledger_account text NOT NULL,
  direction      char(1) NOT NULL CHECK (direction IN ('D','C')),
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  currency       char(3) NOT NULL
);
CREATE INDEX entries_account_idx ON ledger.entries (ledger_account, entry_id DESC);

CREATE TABLE ledger.balances (
  ledger_account text PRIMARY KEY,
  currency       char(3) NOT NULL,
  balance        numeric(18,2) NOT NULL,
  version        bigint NOT NULL                    -- optimistic locking
);
```
Invariant: for every journal, `sum(D) = sum(C)`. Enforce with a deferred constraint trigger and a nightly reconciliation query (`docs/sql/reconciliation.sql`). Entries are append-only: revoke `UPDATE`/`DELETE` on `ledger.entries` from the service role. Reversals are new journals.

### 5.7 `alerts` and `auth`

```sql
CREATE TABLE alerts.alerts (
  alert_id       uuid PRIMARY KEY,
  transaction_id uuid NOT NULL UNIQUE,
  account_id     text NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('REVIEW','DECLINE')),
  final_score    numeric(5,4) NOT NULL,
  reasons        text[] NOT NULL,
  snapshot       jsonb NOT NULL,                    -- transaction + rule + score details for the UI
  status         text NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','CONFIRMED_FRAUD','LEGITIMATE')),
  assigned_to    uuid,
  created_at     timestamptz NOT NULL,
  resolved_at    timestamptz
);
-- Alert queue: open alerts, highest score first
CREATE INDEX alerts_queue_idx ON alerts.alerts (final_score DESC, created_at) WHERE status IN ('OPEN','IN_PROGRESS');
CREATE INDEX alerts_account_idx ON alerts.alerts (account_id, created_at DESC);

CREATE TABLE alerts.audit_log (                     -- append-only
  id          bigserial PRIMARY KEY,
  actor_id    uuid NOT NULL,
  action      text NOT NULL,                        -- 'ALERT_VIEWED','ALERT_RESOLVED','DLQ_REPLAYED','LOGIN'...
  target_type text NOT NULL,
  target_id   text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',
  ip_hash     char(64),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.users (
  user_id       uuid PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,                      -- argon2id
  role          text NOT NULL CHECK (role IN ('analyst','admin')),
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth.refresh_tokens (token_hash char(64) PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users, expires_at timestamptz NOT NULL, revoked_at timestamptz);
```

### 5.8 Performance deliverable
`docs/perf.md` must contain, for the 3 most important queries (alert queue, account history, velocity window):
- the query,
- `EXPLAIN (ANALYZE, BUFFERS)` **before** the index with 10M+ seeded rows,
- the index added and why (column order, partial predicate),
- `EXPLAIN` **after**, with timings.
This is the strongest evidence of "query optimization at scale" in the repo. Seed with `generate_series` scripts in `scripts/seed-large.sql`.

---

## 6. Service specifications

### 6.1 `transaction-api`

**Endpoints**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/transactions` | API key (`X-Api-Key`, hashed in DB) | Request authorization. Requires `Idempotency-Key` header (UUID). Returns 202 |
| GET | `/v1/transactions/:id` | API key | Current status and decision |
| GET | `/health/live`, `/health/ready` | none | Ready checks DB + Kafka metadata |

**POST request body**
```json
{
  "accountId": "acc_000123",
  "card": { "pan": "4111111111111111", "expiryMonth": 12, "expiryYear": 2029, "cvv": "123" },
  "amount": { "value": "1250.90", "currency": "BRL" },
  "merchant": { "id": "mer_771", "name": "Loja Exemplo", "mcc": "5732", "country": "BR", "city": "São Paulo" },
  "channel": "ECOMMERCE",
  "entryMode": "CARD_NOT_PRESENT",
  "device": { "ip": "203.0.113.10", "deviceId": "d-123" },
  "geo": { "lat": -23.55, "lon": -46.63 }
}
```

**Validation** (class-validator DTOs or Zod pipe; reject unknown fields with `whitelist: true, forbidNonWhitelisted: true`):
- PAN: 13–19 digits, Luhn valid. CVV: 3–4 digits, used only to simulate a check and then dropped.
- Amount: decimal string, > 0, ≤ 2 decimals, ≤ 1,000,000.
- Currency: ISO 4217 allow-list. Country: ISO 3166-1 alpha-2. MCC: 4 digits.
- Max body size 16 KB.

**Responses**
- `202 { "transactionId": "...", "status": "PENDING", "links": { "self": "/v1/transactions/..." } }`
- `400` validation (field names only, never echo the PAN)
- `401`, `409` idempotency key in progress, `422` key reused with different body, `429` rate limited, `503` vault or DB unavailable.
- Error format: RFC 9457 Problem Details (`application/problem+json`).

### 6.2 `card-vault`
- Internal network only (not exposed in compose `ports`). mTLS between API and vault as a stretch; v1 uses a shared service token.
- `POST /internal/tokenize` → `{ cardToken, maskedPan, bin, last4 }`. If `pan_hmac` exists, return the existing token (same card = same token).
- `POST /internal/detokenize` exists but is restricted to role `vault-admin` and audited. No other service calls it; it exists to demonstrate the control.
- Encryption: AES-256-GCM via Node `crypto`, random 12-byte IV per encryption, key loaded from env (`VAULT_DEK_V1`) in v1, simulating a KMS. Key rotation: `key_version` column + re-encryption script `pnpm vault:rotate`.
- Memory hygiene: keep PAN in a `Buffer`, `buffer.fill(0)` after use; never convert to string in logs.

### 6.3 `outbox-relay`
Section 4.5. Config: `RELAY_BATCH_SIZE=500`, `RELAY_POLL_MS=100`. Metrics: `outbox_lag_rows`, `outbox_oldest_unpublished_seconds`, `outbox_publish_duration_ms`.

### 6.4 `fraud-rules`

Ruleset (config file `rules.yaml`, versioned; reloading requires restart in v1):

| ID | Name | Logic | Points | Hard decline |
|----|------|-------|--------|--------------|
| R001 | velocity_1m | > 5 transactions for the account in the last 60 s | 30 | no |
| R002 | velocity_1h_amount | sum of amounts in last 1 h > 50% of credit limit | 25 | no |
| R003 | amount_spike | amount > 5 × account's 30-day average (needs ≥ 10 past tx) | 25 | no |
| R004 | impossible_travel | previous tx in another country and implied speed > 900 km/h (haversine distance / time) | 40 | no |
| R005 | foreign_country | merchant country ≠ home country | 10 | no |
| R006 | card_testing | ≥ 3 transactions < R$ 5,00 in the last 10 min | 50 | yes |
| R007 | new_merchant_high_amount | first time at this merchant and amount > R$ 2.000 | 20 | no |
| R008 | blocklisted | merchant, MCC or BIN in blocklist | 100 | yes |
| R009 | night_high_amount | local hour 00:00–05:00 and amount > 3 × average | 15 | no |
| R010 | over_limit | amount > available credit limit | 100 | yes |

- `ruleScore = min(1, sum(points) / 100)`.
- Rules are pure functions `(tx, context) => RuleHit | null` with injected `context` (window counts, profile, last tx). Easy to unit test with tables of cases.
- Context loading: one SQL round trip per transaction (CTE that returns all window aggregates at once). Document the query in `docs/perf.md`.
- After evaluation, insert the transaction into `account_activity` and `known_merchants` in the same DB transaction.

### 6.5 `anomaly-scorer`

Per-account exponentially weighted statistics (α = 0.1):
```
mean_t = α·x + (1−α)·mean_{t−1}
var_t  = (1−α)·(var_{t−1} + α·(x − mean_{t−1})²)
z      = (x − mean_{t−1}) / sqrt(var_{t−1} + ε)
```
Features:
- `amountZ` on log(amount)
- `interArrivalZ` on log(seconds since last tx)
- `hourOfDayDeviation` = 1 − (hist[hour] / max(hist))
- `newMerchant` (boolean, from local table)

Score:
```
raw = 0.5·max(0, amountZ) + 0.2·max(0, −interArrivalZ) + 0.2·hourOfDayDeviation + 0.1·newMerchant
anomalyScore = 1 / (1 + e^{−(raw − 2)})     // logistic, centered at raw = 2
```
- Cold start: if `n < 10`, score with population defaults by `riskTier` and set `baselineSampleSize` so decision-engine can down-weight it.
- Baseline is updated **after** scoring. Transactions later confirmed as fraud by analyst feedback are excluded: on `CONFIRMED_FRAUD`, revert that tx's contribution (store the last 50 contributions per account to allow this) or simply skip updates while an alert is open; document the choice.
- All thresholds and α in config; record parameter tuning in `docs/model.md` with the simulator's precision/recall.

### 6.6 `decision-engine`
- On each incoming result: upsert into `decision.pending`. If both parts present → decide, delete pending row, write `decision.decisions`, write outbox, all in one transaction.
- Timeout sweeper every 250 ms: `SELECT ... WHERE deadline_at < now() FOR UPDATE SKIP LOCKED` → decide with available part, `partial = true`. If nothing arrived from rules (should not happen), decision = `REVIEW`.
- Fusion:
  - weight of anomaly score = 0.4 if `baselineSampleSize ≥ 10`, else 0.15 (rules get the rest).
  - `finalScore = wRules·ruleScore + wAnomaly·anomalyScore`
  - `hardDecline` → `DECLINE` regardless of score.
  - `finalScore < 0.40` → `APPROVE`; `0.40 ≤ finalScore < 0.75` → `REVIEW`; `≥ 0.75` → `DECLINE`.
- Thresholds in config with `config_version` recorded in every decision (auditability).
- `latencyMs` = `decidedAt − requestedAt`; exported as a histogram.

### 6.7 `ledger`
- Consumes only `APPROVE`. Creates one journal with two entries (customer debit, merchant credit).
- Uniqueness of `journals.transaction_id` is the business-level idempotency guard, on top of `processed_events`.
- Balance update with optimistic locking (`UPDATE ... WHERE version = $v`), retry on conflict.
- Analyst marks an approved transaction as fraud later (stretch) → reversal journal.

### 6.8 `alerts-gateway`

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | public | Email + password → access token (body) + refresh token (httpOnly, Secure, SameSite=Strict cookie) |
| POST | `/auth/refresh` | cookie | Rotates refresh token (old one revoked; reuse detection revokes the whole family) |
| POST | `/auth/logout` | any | Revokes refresh token |
| GET | `/v1/alerts?status=&minScore=&accountId=&cursor=&limit=` | analyst | Keyset pagination on `(final_score, created_at, alert_id)` |
| GET | `/v1/alerts/:id` | analyst | Details; writes `ALERT_VIEWED` to audit log |
| POST | `/v1/alerts/:id/assign` | analyst | Assign to self |
| POST | `/v1/alerts/:id/resolve` | analyst | Body `{ verdict, note }` → updates alert, audit log, publishes feedback event (via outbox) |
| GET | `/v1/accounts/:accountId/timeline` | analyst | Last 100 decisions + ledger entries for the account |
| GET | `/v1/metrics/summary?window=15m` | analyst | tx/s, approve/review/decline rates, p95 latency |
| GET | `/v1/stream` | analyst | SSE: `alert.created`, `alert.updated`, `decision.made` (sampled), `metrics.tick` every 2 s |
| POST | `/admin/dlq/replay` | admin | Replays a DLQ range (audited) |
| GET | `/admin/consumers/lag` | admin | Consumer group lag via Kafka admin API |

- SSE auth: short-lived token in query param is common but leaks into logs; prefer cookie-based session for the stream and document it (ADR-006).
- Backpressure on SSE: drop `decision.made` samples if the client buffer grows; never drop `alert.*`.

### 6.9 `simulator`
- `pnpm sim:seed --accounts 10000` → publishes profiles to `accounts.profiles.v1` and creates historical baseline traffic (30 days compressed).
- `pnpm sim:run --tps 200 --duration 10m --fraud-rate 0.02` → sends live traffic over HTTP.
- Scenarios (each injectable alone with `--scenario <name>`):
  - `normal`: per-account lognormal amounts, Poisson arrivals, home city, mostly known merchants.
  - `card_testing`: burst of 5–10 transactions of R$ 1–4 within minutes.
  - `account_takeover`: sudden high amounts at new merchants, different device hash.
  - `impossible_travel`: São Paulo then Lisbon 30 min later.
  - `merchant_compromise`: many accounts hitting the same merchant with abnormal amounts.
- Writes ground truth (`transactionId → isFraud, scenario`) to `simulator_output/ground_truth.csv` so `pnpm eval` can compute precision, recall and F1 per scenario.
- Uses only test PANs (Luhn-valid ranges reserved for testing). Never real card numbers.

---

## 7. Security requirements (PCI DSS-inspired)

> Disclaimer for the README: "This project demonstrates controls inspired by PCI DSS v4.0. It is not a certified or production-ready payment system."

| PCI DSS area | Control implemented | Where |
|--------------|---------------------|-------|
| Req. 3 — Protect stored account data | Tokenization; AES-256-GCM; HMAC for lookup; CVV never stored; masked PAN (first 6 / last 4) everywhere else | `card-vault`, contracts |
| Req. 3.6/3.7 — Key management | Versioned keys, rotation script, keys only via env/secret, never in repo | `card-vault`, `scripts/vault-rotate.ts` |
| Req. 4 — Encrypt transmission | TLS termination at reverse proxy (Caddy/Traefik with local certs) as compose profile; Kafka SASL_SSL profile (stretch) | `infra/` |
| Req. 6 — Secure development | Input validation, parameterized SQL only, CodeQL, `pnpm audit`, Dependabot, secret scanning, threat model doc, code review checklist | CI, `docs/security/` |
| Req. 7 — Least privilege | DB role per service; RBAC (`analyst`, `admin`); vault internal-only | migrations, guards |
| Req. 8 — Authentication | argon2id, lockout after 5 failures for 15 min, short JWT, refresh rotation with reuse detection | `alerts-gateway` |
| Req. 10 — Logging and monitoring | Append-only audit log; structured logs with correlation ID; PAN/CVV redaction verified by test | all services |
| Req. 11 — Testing | Security tests in CI (section 13.5) | `tests/security` |

Additional rules:
- **Logging redaction**: pino `redact` paths for `*.pan`, `*.cvv`, `*.card`, `authorization`, `cookie`, `password`. A test sends a request with a known PAN and asserts that it appears nowhere in captured logs, Kafka topics or any table outside `vault` (grep the DB dump).
- HTTP hardening: `helmet`, strict CORS allow-list, `@nestjs/throttler` (e.g., 100 req/min per API key on POST, 10/min on login), request size limits, no stack traces in responses.
- SQL: parameterized queries only; lint rule forbids template-string SQL with interpolation.
- Secrets: `.env.example` with placeholders; `.env` in `.gitignore`; gitleaks in CI.
- Dependencies: lockfile committed; Renovate or Dependabot; `pnpm audit --prod` fails CI on high severity.
- `docs/security/threat-model.md`: STRIDE table for each service and data flow.
- Frontend: no tokens in `localStorage` (access token in memory, refresh in httpOnly cookie), CSP header, escape all user content (React does by default; no `dangerouslySetInnerHTML`).

---

## 8. Frontend (`apps/web`)

### 8.1 Figma first
Before coding, design 4 screens in Figma (free plan is enough): Live Monitor, Alert Queue, Alert Detail, Account Timeline. Define tokens (colors, spacing, type scale) as Figma variables and mirror them in `tailwind.config.ts`. Link the Figma file in the README and include screenshots side by side with the implemented screens. This directly answers the job requirement "translate Figma designs into production-ready components".

### 8.2 Screens

**Login**
- Email, password, error states, lockout message.

**Live Monitor (`/`)**
- KPI cards: transactions/s, approve %, review %, decline %, p95 decision latency, consumer lag (admin only).
- Live line chart of tx/s and decline rate (last 15 min, SSE `metrics.tick`).
- Live feed of recent decisions (virtualized list, max 200 rows, colored badge by decision).

**Alert Queue (`/alerts`)**
- Table: score (color bar), decision, account, amount, merchant, country, fired rules (chips), age, status, assignee.
- Filters: status, min score, account, scenario tag; sort by score or age; keyset "load more".
- New alerts appear on top in real time with a subtle highlight; a counter "N new alerts" if the user scrolled down.

**Alert Detail (`/alerts/:id`)**
- Transaction card (masked PAN only), merchant, geo (small static map or coordinates), device hash.
- Score breakdown: rule points bar chart, anomaly features with z-scores, weights used, final score vs thresholds.
- Account mini-timeline (last 20 transactions, amount chart with this one highlighted).
- Actions: Assign to me, Confirm fraud, Mark legitimate (with required note). Optimistic UI with rollback on error.

**Account Timeline (`/accounts/:id`)**
- Profile (home country, risk tier, limit), baseline stats, full history with decisions and ledger postings, balance.

### 8.3 Frontend engineering
- Structure: `features/<feature>/{components,hooks,api}`; shared UI in `components/ui` (Button, Badge, Card, Table, Dialog, Input, Select, Toast) built with Tailwind, accessible (keyboard, focus rings, ARIA).
- Data: TanStack Query for REST; one `useEventStream()` hook for SSE that dispatches into the query cache.
- Forms: React Hook Form + Zod (same schemas from `libs/contracts` where possible).
- Types: generated from the API OpenAPI spec (`@nestjs/swagger` → `openapi-typescript`).
- Dark mode via Tailwind `dark:` class strategy.
- Tests: Vitest + Testing Library for components; Playwright for the main flow (login → open alert → resolve).
- Performance: route-level code splitting; Lighthouse score ≥ 90 on Alert Queue.

---

## 9. Fraud detection quality

### 9.1 Evaluation
`pnpm eval` joins `ground_truth.csv` with `decision.decisions` and outputs per scenario: precision, recall, F1, review rate, decline rate, false positive rate on normal traffic. Store the result table in `docs/model.md` per version.

### 9.2 Targets (on simulator data)
- Recall ≥ 0.90 for `card_testing` and `impossible_travel`.
- Recall ≥ 0.70 for `account_takeover`.
- False positive (REVIEW + DECLINE) on `normal` ≤ 3%.

### 9.3 Explainability
Every decision carries `reasons[]`. The UI shows them in plain language. This is a real requirement in fraud operations and a good interview point.

### 9.4 Stretch: LSTM autoencoder service
- `apps/anomaly-lstm` in Python (FastAPI not needed; a Kafka consumer with `confluent-kafka`), trained offline on simulator sequences per account, reconstruction error → score.
- Publishes to `fraud.scores.v1` with `modelVersion: "lstm-ae-1.0"`; decision-engine picks the highest-version score or averages (configurable).
- Shows polyglot consumers on the same contract and connects to real experience from the bank.

---

## 10. Observability

- **Tracing**: OpenTelemetry SDK in every service; inject `traceparent` into Kafka headers on produce and extract on consume, so one trace spans API → relay → rules/scorer → decision → ledger/alerts. Jaeger in compose. Screenshot of a full trace in the README.
- **Metrics** (Prometheus, `/metrics` on each service):
  - `http_request_duration_seconds` (route, status)
  - `kafka_consumer_messages_total` (topic, group, outcome=`ok|duplicate|retry|dlq`)
  - `kafka_consumer_processing_seconds`
  - `decision_latency_seconds` histogram
  - `decisions_total` (decision)
  - `outbox_lag_rows`, `outbox_oldest_unpublished_seconds`
  - consumer group lag via kafka-exporter
- **Dashboards**: Grafana provisioned from `infra/grafana/dashboards/*.json`: Throughput & latency, Kafka lag, Fraud outcomes, Errors/DLQ.
- **Alerts** (Prometheus rules, documented even if not wired to a pager): lag > 10k for 2 min, DLQ rate > 0, outbox oldest > 30 s, p95 decision latency > 1 s.
- **Logs**: pino JSON with `service`, `correlationId`, `transactionId`, `traceId`. No PII.
- **Kafka UI**: Kafbat UI (kafka-ui) in compose for browsing topics and DLQs during demos.

---

## 11. Non-functional requirements

| Item | Target (laptop, 3 brokers, all services in Docker) |
|------|-----------------------------------------------------|
| Throughput | 200 tx/s sustained for 10 min; stretch 500 tx/s |
| End-to-end decision latency | p95 < 500 ms, p99 < 1 s at 200 tx/s |
| Data loss | 0 transactions lost when any one consumer or one broker is killed |
| Duplicates | 0 duplicate ledger journals after chaos test |
| Recovery | Consumer restart catches up 100k-message backlog in < 2 min |
| Horizontal scale | Running 3 replicas of `fraud-rules` increases throughput; partitions spread across replicas |

All numbers measured, not assumed; results go to `docs/perf.md` with machine specs.

---

## 12. Repository layout

```
fraudstream/
├─ apps/
│  ├─ transaction-api/
│  ├─ card-vault/
│  ├─ outbox-relay/
│  ├─ fraud-rules/
│  ├─ anomaly-scorer/
│  ├─ decision-engine/
│  ├─ ledger/
│  ├─ alerts-gateway/
│  ├─ simulator/
│  └─ web/
├─ libs/
│  ├─ contracts/        # Zod event + API schemas, topic names, shared types
│  ├─ kafka/            # producer/consumer wrappers, idempotent handler, retry/DLQ, tracing propagation
│  ├─ outbox/           # outbox writer + relay core
│  ├─ db/               # pg pool, migration runner, transaction helper
│  ├─ security/         # redaction config, masking, hashing helpers
│  ├─ observability/    # OTel setup, metrics registry, logger
│  └─ testing/          # Testcontainers fixtures, factories
├─ infra/
│  ├─ docker-compose.yml
│  ├─ docker-compose.observability.yml
│  ├─ kafka/init-topics.sh
│  ├─ postgres/init-roles.sql
│  ├─ prometheus/  grafana/  caddy/
├─ migrations/<service>/
├─ scripts/             # seed-large.sql, vault-rotate.ts, dlq-replay.ts, eval.ts
├─ tests/
│  ├─ e2e/  load/ (k6)  chaos/  security/
├─ docs/
│  ├─ SPEC.md (this file)
│  ├─ adr/  security/  perf.md  model.md  runbook.md
├─ .github/workflows/ci.yml
├─ CLAUDE.md
├─ README.md
└─ package.json / pnpm-workspace.yaml / nx.json
```

Each NestJS service follows: `src/{main.ts, app.module.ts, config/, domain/, application/, infrastructure/{kafka,db,http}/}` with domain logic free of framework imports (makes rules and scoring trivially unit-testable).

---

## 13. Testing strategy

### 13.1 Unit (fast, no containers)
- Every rule with table-driven cases (boundaries: exactly 5 tx, 6 tx, etc.).
- EWMA math vs a reference implementation; fusion thresholds; masking; Luhn; money arithmetic.
- Coverage ≥ 85% on `domain/` folders.

### 13.2 Integration (Testcontainers: Kafka + Postgres)
- Outbox: insert 1,000 rows, run 2 relay instances, assert each event published exactly once and in order per key.
- Idempotent consumer: deliver the same event 3 times → one side effect.
- Retry: inject a transient DB failure → message succeeds on retry, offset committed once.
- DLQ: publish an invalid payload → lands in DLQ with all diagnostic headers; partition keeps flowing.
- Rebalance: start 2 consumers, stop one mid-stream → no loss, no duplicate side effects.

### 13.3 Contract
- For each topic: producer fixtures validated against consumer schemas from `libs/contracts`. CI fails on incompatibility.
- OpenAPI snapshot test for public endpoints.

### 13.4 End-to-end
- `docker compose up` + simulator scenario `card_testing` for one account → assert `DECLINE` within 3 s and alert visible via API.
- Playwright: login → alert appears via SSE → resolve → status updates.

### 13.5 Security tests
- PAN leak test (section 7).
- AuthZ matrix: every endpoint × role × expected status.
- Brute-force lockout, refresh token reuse detection.
- SQL injection payloads on all string inputs return 400 and leave DB untouched.

### 13.6 Load and chaos
- k6 script ramps 50 → 200 → 500 tx/s; output summary committed in `docs/perf.md`.
- Chaos script: during load, `docker kill` one broker, then one `fraud-rules` replica, then the `ledger` service; after recovery, run reconciliation: `count(approved decisions) = count(ledger journals)` and ledger balances net to zero.

---

## 14. Local environment

### 14.1 Compose services
`kafka-1..3` (KRaft), `init-topics`, `postgres`, `kafka-ui`, `jaeger`, `prometheus`, `grafana`, `kafka-exporter`, all apps, optional `caddy` (TLS profile), optional `schema-registry` (stretch profile). Profiles: `core`, `observability`, `tls`, `lowmem` (1 broker, RF=1, `min.insync.replicas=1`).

### 14.2 Commands
```
pnpm i
cp .env.example .env
docker compose --profile core --profile observability up -d
pnpm db:migrate
pnpm sim:seed --accounts 10000
pnpm sim:run --tps 100 --duration 5m --fraud-rate 0.02
open http://localhost:5173   # web (user: analyst@demo.local / see .env.example)
open http://localhost:8080   # kafka-ui
open http://localhost:3000   # grafana
open http://localhost:16686  # jaeger
pnpm eval
```

### 14.3 Environment variables (`.env.example`)
```
NODE_ENV=development
DATABASE_URL_PAYMENTS=postgres://payments_svc:change-me@localhost:5432/fraudstream
DATABASE_URL_VAULT=postgres://vault_svc:change-me@localhost:5432/fraudstream
# ...one per service
KAFKA_BROKERS=localhost:19092,localhost:29092,localhost:39092
KAFKA_CLIENT_ID_PREFIX=fraudstream
VAULT_DEK_V1=base64:REPLACE_WITH_32_RANDOM_BYTES
VAULT_HMAC_KEY=base64:REPLACE_WITH_32_RANDOM_BYTES
VAULT_SERVICE_TOKEN=change-me
JWT_ACCESS_SECRET=change-me
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
HASH_PEPPER=change-me
DECISION_APPROVE_BELOW=0.40
DECISION_DECLINE_FROM=0.75
DECISION_JOIN_TIMEOUT_MS=2000
ANOMALY_ALPHA=0.1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```
Config is validated at startup with Zod; the service refuses to boot with missing or placeholder secrets when `NODE_ENV=production`.

---

## 15. CI/CD (GitHub Actions)

`ci.yml` jobs:
1. `lint-typecheck`: ESLint (incl. `eslint-plugin-security`), Prettier check, `tsc --noEmit` for affected projects (Nx affected).
2. `unit`: Vitest/Jest with coverage upload.
3. `integration`: Testcontainers (Docker available on GitHub runners).
4. `contracts`: schema compatibility tests.
5. `security`: CodeQL, `pnpm audit --prod --audit-level high`, gitleaks, Trivy scan of built images.
6. `build-images`: multi-stage Dockerfiles, non-root user, distroless or alpine runtime, image size reported.
7. `e2e` (on `main` and PRs labeled `e2e`): compose up + scenario test + Playwright.

Branch protection: PR required, CI green, conventional commits, CHANGELOG via release-please (optional).

---

## 16. Architecture Decision Records (write each in ~1 page)

| ADR | Title | Key points to cover |
|-----|-------|---------------------|
| 001 | Kafka instead of RabbitMQ | Log retention and replay, consumer groups vs competing consumers, partition ordering, throughput; when RabbitMQ would still be better (routing, per-message TTL, request/reply). Use your production RabbitMQ experience here |
| 002 | Co-partitioning by `accountId` with 12 partitions | Ordering, local joins, hot partitions risk (merchant_compromise scenario), why partition count is fixed |
| 003 | Kafka client library choice | Maintenance status, API, performance, librdkafka |
| 004 | Transactional outbox (polling) vs Kafka transactions vs CDC | Atomicity with DB, operational cost, latency |
| 005 | Asynchronous decision (202) vs synchronous authorization | Real-world constraints, request/reply alternative |
| 006 | SSE vs WebSocket for the dashboard | One-way feed, auth, proxies, reconnection |
| 007 | PostgreSQL for consumer state vs Redis vs Kafka Streams/ksqlDB | Exactly-once reasoning, simplicity, recovery |
| 008 | Tokenization vault design | Scope reduction, key versioning, HMAC lookup |
| 009 | Money representation | Decimal strings, `numeric`, no floats |

---

## 17. Milestones and acceptance criteria

### M0 — Skeleton (1–2 days)
- [ ] Monorepo with pnpm + Nx, TS strict, ESLint, Prettier, Husky pre-commit.
- [ ] `docker-compose.yml` with 3 Kafka brokers (KRaft), Postgres, kafka-ui; `init-topics` creates all topics from section 4.1.
- [ ] `libs/contracts` with envelope + all v1 event schemas.
- [ ] CI runs lint + typecheck + unit on PR.

### M1 — Ingestion + vault + outbox (2–3 days)
- [ ] `card-vault` tokenizes with AES-256-GCM; unit tests for encrypt/decrypt, rotation.
- [ ] `transaction-api` POST/GET with validation, idempotency keys, Problem Details errors, rate limiting.
- [ ] Transaction + outbox written atomically; `outbox-relay` publishes with `SKIP LOCKED`.
- [ ] Integration test: 2 relays, 1,000 events, exactly-once publish, per-key order.
- [ ] PAN leak test green.

### M2 — Kafka consumer library (2 days)
- [ ] `libs/kafka`: idempotent handler, manual commit after DB commit, retry topic, DLQ with headers, graceful shutdown, rebalance logging, trace propagation.
- [ ] Integration tests from 13.2 green.
- [ ] `pnpm dlq:replay` CLI working.

### M3 — Rules + anomaly + decision (3–4 days)
- [ ] `fraud-rules` R001–R010 with table-driven tests and the single-roundtrip context query.
- [ ] `anomaly-scorer` EWMA baseline with cold start.
- [ ] `decision-engine` join + timeout sweeper + fusion + config version.
- [ ] E2E: `card_testing` → `DECLINE` in < 3 s.

### M4 — Ledger (1–2 days)
- [ ] Double-entry journals, append-only entries, balances with optimistic locking.
- [ ] Reconciliation SQL + test.

### M5 — Alerts gateway + auth (2–3 days)
- [ ] Auth with argon2id, lockout, refresh rotation + reuse detection, RBAC guards.
- [ ] Alerts REST with keyset pagination, audit log, SSE stream.
- [ ] AuthZ matrix tests.

### M6 — Frontend (4–5 days)
- [ ] Figma file with 4 screens and tokens, linked in README.
- [ ] Screens from section 8.2 implemented with Tailwind, responsive, dark mode, accessible.
- [ ] Live updates via SSE; optimistic resolve.
- [ ] Playwright main-flow test green.

### M7 — Simulator, evaluation, observability (2–3 days)
- [ ] Scenarios from 6.9 with ground truth; `pnpm eval` table in `docs/model.md` meeting 9.2 targets.
- [ ] OTel traces across Kafka visible in Jaeger; Grafana dashboards provisioned.

### M8 — Performance, chaos, docs (2–3 days)
- [ ] `docs/perf.md` with EXPLAIN before/after on 10M+ rows and k6 results.
- [ ] Chaos test passes: no loss, no duplicates, reconciliation clean.
- [ ] All ADRs written; threat model; runbook (`docs/runbook.md`: how to replay DLQ, handle lag, rotate keys).
- [ ] README final (section 19), with architecture diagram, GIF of the dashboard, trace screenshot, results tables.

### Stretch
- [ ] Schema Registry + Avro with `BACKWARD` compatibility.
- [ ] Kafka transactions (consume-transform-produce) in `decision-engine` as an alternative to outbox, compared in ADR-004.
- [ ] Debezium CDC replacing the polling relay.
- [ ] Python LSTM autoencoder scorer (9.4).
- [ ] SASL_SSL + ACLs per service principal.
- [ ] Synchronous authorization variant with request/reply topics.
- [ ] Deploy to a single VM or free tier with a public read-only demo (no real data).

Estimated total: 4–6 weeks part time. M0–M3 alone (about 1.5–2 weeks) already prove the Kafka must-have; publish the repo at that point and keep iterating.

---

## 18. `CLAUDE.md` template

```markdown
# FraudStream — instructions for Claude Code

- Read docs/SPEC.md before any task. Follow its section numbers when referring to requirements.
- Work one milestone at a time (SPEC §17). Do not start the next milestone until the current checklist is green.
- TypeScript strict. No `any`. Domain code (rules, scoring, fusion, money) must not import NestJS or Kafka.
- SQL: parameterized only, migrations per service under migrations/<service>/. Every new index needs a comment with the query it serves.
- Kafka: never enable auto-commit; commit offsets only after the DB transaction commits. All consumers use libs/kafka idempotent handler.
- Never log, persist outside card-vault, or put in Kafka a PAN or CVV. Run `pnpm test:security` after touching ingestion.
- Money is a decimal string / numeric(18,2). Never use floating point for amounts.
- Add or update tests with every change: unit for domain, integration (Testcontainers) for Kafka/DB behavior.
- Run `pnpm lint && pnpm typecheck && pnpm test` before declaring a task done.
- Commit messages: Conventional Commits.
```

---

## 19. README outline (what recruiters will read)

1. One-paragraph pitch + badges (CI, coverage).
2. GIF of the live dashboard catching a card-testing attack.
3. Architecture diagram (Mermaid) + one paragraph per service.
4. "Kafka in this project": partitioning, consumer groups, idempotency, outbox, retry/DLQ, replay, ordering guarantees — each with a link to the code.
5. "Security": tokenization vault, encryption, redaction, auth, audit — with the PCI DSS mapping table and the disclaimer.
6. "Database performance": the EXPLAIN before/after table.
7. "Fraud detection results": precision/recall per scenario.
8. "Performance and resilience": k6 and chaos results.
9. Quick start (section 14.2).
10. Figma link + screenshots side by side.
11. ADR index.
12. "What I would do next in production" (managed Kafka, KMS/HSM, real model monitoring, multi-region).

---

## 20. Interview talking points (map to the job description)

| Job requirement | Point to |
|-----------------|----------|
| Kafka in production, event-driven systems | §4 design, `libs/kafka`, chaos test results, ADR-001 (comparison with your production RabbitMQ experience) |
| Node.js, NestJS, TypeScript | All services, domain/infrastructure split |
| MySQL/PostgreSQL, schema design, query optimization at scale | §5, `docs/perf.md` with 10M+ row benchmarks; mention the 16 TB+ Oracle / 4B-row tables from your day job |
| Secure coding, PCI DSS | §7, vault, leak tests, threat model |
| REST APIs | OpenAPI spec, Problem Details, idempotency keys, keyset pagination |
| React + Tailwind from Figma | §8, Figma link, screenshots |
| AI coding tools | `CLAUDE.md`, mention the workflow used to build the project |
| Fraud / anomaly detection, financial data modeling | §6.4–6.6, §9, ledger double entry; link to your LSTM autoencoder work at the bank |
| Microservices | 8 independently deployable services, contracts, per-service DB schema |
