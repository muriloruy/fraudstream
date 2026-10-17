# Runbook

Operational procedures for the local environment. Where to look when something is slow or stuck: [Observability](#observability).

## Start and stop

```bash
pnpm env:init                                  # first time only: .env with random secrets
docker compose --profile core up -d --wait     # 3 brokers + Postgres + kafka-ui
docker compose --profile core --profile observability up -d --wait   # + Jaeger, Prometheus, Grafana
docker compose --profile core ps               # all services healthy, init-topics exited (0)
docker compose --profile core down             # stop, keep data volumes
```

`--wait` returns once every broker and Postgres are healthy and `init-topics` has finished. `init-topics` is idempotent: it only creates topics missing from the cluster.

## Low-memory profile

```bash
docker compose --profile lowmem up -d --wait   # 1 broker, RF=1, min.insync.replicas=1
```

The single broker answers on the same names and ports as the first core broker (`kafka-1:9092`, `localhost:19092`). Stop one profile before starting the other: they share host ports.

## Topics

- The catalogue lives in `libs/contracts/src/topics.ts`; `infra/kafka/topics.conf` is generated from it with `pnpm topics:generate` (a unit test fails if they drift).
- `pnpm topics:verify` checks partitions, replication factor, cleanup policy, retention and `min.insync.replicas` of every topic and exits non-zero on any mismatch.
- Broker auto-creation is disabled: producing to a topic outside the catalogue fails with `UNKNOWN_TOPIC_OR_PARTITION`.
- To add a topic: edit `topics.ts`, run `pnpm topics:generate`, then `docker compose --profile core run --rm init-topics`.

## Database

- One schema and one login role per service (`payments_svc`, `vault_svc`, ...). Each role owns only its schema and has it as `search_path`; access to other schemas is denied.
- Role passwords come from the `DATABASE_URL_*` entries in `.env` and are applied on the **first** start of the Postgres volume only.

## Reset everything

Deletes all Kafka and Postgres data (needed after changing role passwords in `.env`):

```bash
docker compose --profile core down -v
docker compose --profile lowmem down -v
```

## Services

- Images are built from `infra/docker/node-service.Dockerfile` (`docker compose ... up --build`). Each service applies its own migrations at start (`MIGRATE_ON_START=true`), connected as its own role; `pnpm db:migrate` does the same from the host.
- Inside compose, `DATABASE_HOST=postgres` replaces `localhost` in the `.env` connection strings.
- `pnpm --filter @fraudstream/<service> dev` builds and runs a service on the host with `.env`.

## API keys

```bash
pnpm apikey:create <client-name>   # prints the key once; only its SHA-256 is stored
```

Revoke with `UPDATE payments.api_keys SET revoked_at = now() WHERE name = '<client-name>'` (cached for up to 60 s per instance).

## Rotate the vault encryption key (PCI DSS 3.6/3.7)

1. Add `VAULT_DEK_V2=base64:$(openssl rand -base64 32)` to `.env` (keep `VAULT_DEK_V1`).
2. Restart `card-vault`: new cards are encrypted with v2 (the highest version).
3. Re-encrypt existing cards: `pnpm vault:rotate` (batches with `FOR UPDATE SKIP LOCKED`, safe under traffic; tokens do not change).
4. Check `SELECT key_version, count(*) FROM vault.cards GROUP BY 1` shows only v2, then remove `VAULT_DEK_V1`.

## Outbox relay

- `curl localhost:9464/metrics | grep outbox_` — `outbox_lag_rows` and `outbox_oldest_unpublished_seconds` should stay near 0.
- Rows that failed to publish keep `attempts` and `last_error`: `SELECT id, attempts, last_error FROM payments.outbox WHERE published_at IS NULL ORDER BY id LIMIT 20`.
- Scaling `outbox-relay-payments` is safe: one instance publishes (advisory-lock leader), the others take over if it dies.

## Dead letter queues (SPEC §4.6)

Each consumer group has `<topic>.<group>.dlq` (30-day retention). A message lands there when it is invalid (schema, unknown version, invariant) or still fails after 3 in-process retries and 5 retry-topic rounds. Its partition keeps flowing.

1. **Inspect** in kafka-ui (<http://localhost:8080>): open the DLQ topic and read the headers `dlq-reason`, `dlq-error-message`, `original-topic`, `original-partition`, `original-offset`, `failed-at`. Or list a range without touching anything:

   ```bash
   pnpm dlq:replay --topic payments.transactions.v1.fraud-rules.dlq --from 0 --to 100 --dry-run
   ```

2. **Fix the cause** (deploy the fix, correct reference data, ...).
3. **Replay** the range to the original topic (add `--partition <n>` to limit it to one partition):

   ```bash
   pnpm dlq:replay --topic payments.transactions.v1.fraud-rules.dlq --from 0 --to 100
   ```

   Replayed messages carry `replayed-at` and lose the `dlq-*`/`retry-*` headers. Every consumer group of the original topic receives them again; they are idempotent by `event-id`, so groups that already processed an event skip it, and replaying the same range twice is harmless.

## Observability

Start it with the stack: `docker compose --profile core --profile observability up -d --wait`.

| Tool       | URL                                        | What for                                                    |
| ---------- | ------------------------------------------ | ----------------------------------------------------------- |
| Grafana    | <http://localhost:3100>                    | dashboards (folder _FraudStream_); admin password in `.env` |
| Prometheus | <http://localhost:9090/alerts>             | alert rules and their state; `/targets` shows every scrape  |
| Jaeger     | <http://localhost:16686>                   | one trace per transaction, across HTTP and Kafka            |
| kafka-ui   | <http://localhost:8080>                    | topics, consumer groups, DLQ messages and their headers     |
| `/metrics` | `localhost:3000`, `:3002`-`:3006`, `:9464` | raw Prometheus metrics of each service                      |

Dashboards: **Throughput & latency**, **Kafka lag**, **Fraud outcomes**, **Errors & DLQ** (`infra/grafana/dashboards/*.json`, provisioned at startup, read-only in the UI). Alert rules live in `infra/prometheus/alerts.yml`; there is no pager, they show in Prometheus and on the dashboards.

### Following one transaction

Every log line handled for a message or request carries `traceId`, `correlationId` and `transactionId`. Paste the `traceId` in Jaeger (_Search_ → trace id), or search by tag `fraudstream.correlation_id=<transactionId>`. The trace shows `POST /v1/transactions` in transaction-api, then for each hop a `publish <topic>` span (outbox relay) and a `process <topic>` span (consumer) with its SQL underneath, down to the decision and the ledger/alerts consumers. A trace without a hop you expect means that service has not processed the message yet: check its lag.

Tracing is preloaded with `node --import @fraudstream/observability/register` (ES modules must be instrumented before they load). `OTEL_SDK_DISABLED=true` turns it off; without the observability profile, exports fail quietly.

### Consumer lag

Alert `ConsumerLagHigh`: a group is more than 10,000 messages behind for 2 minutes.

1. **Kafka lag** dashboard: which group and topic; is lag growing (consumer too slow) or flat (consumer stopped)?
2. `docker compose --profile core ps <service>`: is it running and healthy? Look at its logs for rebalances (`partitions assigned` / `revoked`) or repeated errors.
3. **Throughput & latency** → _Message processing p95 by consumer group_: slow handlers usually mean slow SQL (open a trace in Jaeger and look at the `pg` spans).
4. Fraud-flow topics have 12 partitions, so a group can grow to 12 consumers (range assignor keeps co-partitioning, ADR-002); the scaling check is part of M8. The admin endpoint `GET /admin/consumers/lag` (alerts-gateway) shows the same numbers.

### Dead letter messages

Alert `DeadLetterMessages`: any message landed in a `*.dlq` topic in the last 5 minutes. **Errors & DLQ** shows which topic; then follow [Dead letter queues](#dead-letter-queues-spec-46) to inspect, fix and replay.

### Outbox not publishing

Alert `OutboxStalled`: the oldest unpublished outbox row is older than 30 s, so events are stuck in Postgres.

1. **Kafka lag** → _Outbox backlog by schema_ tells which service (`payments` is outbox-relay-payments; the others are embedded in their service).
2. Brokers reachable? `kafka_brokers` on the same dashboard, and the relay's `outbox publish failed; backing off` warnings.
3. `SELECT id, attempts, last_error FROM <schema>.outbox WHERE published_at IS NULL ORDER BY id LIMIT 20` shows the error. See [Outbox relay](#outbox-relay).

### Slow decisions

Alert `DecisionLatencyHigh`: p95 of `decision_latency_seconds` (request to decision) above 1 s for 2 minutes. Target is p95 < 500 ms at 200 tx/s (SPEC §11).

1. **Throughput & latency**: compare API p95, processing p95 per group and lag. Lag on `fraud.rule-results.v1` / `fraud.scores.v1` points at decision-engine; on `payments.transactions.v1` at rules or scorer.
2. Partial decisions (`partial = true` in `decision.decisions`) mean one side missed the 2 s join window (`DECISION_JOIN_TIMEOUT_MS`).
3. Open a slow trace in Jaeger: the widest span is the bottleneck. Gaps between `publish` and `process` spans are time spent waiting in Kafka (lag); gaps before `publish` are outbox polling (`RELAY_POLL_MS`).

Requests older than one hour when decided (simulator seed history, DLQ replays) are not observed in the histogram, so a replay does not trip this alert.
