# Runbook

Operational procedures for the local environment. Lag handling is added with the observability stack (SPEC §17 M7).

## Start and stop

```bash
pnpm env:init                                  # first time only: .env with random secrets
docker compose --profile core up -d --wait     # 3 brokers + Postgres + kafka-ui
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
- `pnpm topics:verify` checks partitions, replication factor, cleanup policy, retention and `min.insync.replicas` of every topic and exits non-zero on any mismatch. It also fails if any topic, internal ones included, has a replication factor below the expected one (3 on `core`), if a broker is missing, or if any partition is leaderless or under-replicated (see [Kafka replication](#kafka-replication)).
- `init-topics` sizes replication from the brokers the cluster is meant to have (its KRaft voter set: 3 on `core`, 1 on `lowmem`; `EXPECTED_BROKERS` overrides it) and waits up to 180 s for all of them to register. If one never does, it exits 1 rather than create topics with a lower replication factor.
- Broker auto-creation is disabled: producing to a topic outside the catalogue fails with `UNKNOWN_TOPIC_OR_PARTITION`.
- To add a topic: edit `topics.ts`, run `pnpm topics:generate`, then `docker compose --profile core run --rm init-topics`.

## Kafka replication

On `core` every topic, `__consumer_offsets` and `__transaction_state` included, must have replication factor 3 and `min.insync.replicas=2` (SPEC §4.1, §14.1). A cluster whose topics were created with RF=1 (for example by an `init-topics` that ran before all brokers had registered) works until one broker restarts; then every partition it led goes `Leader: none` with an empty ISR, and producers, consumers and consumer-group commits stall.

### Detect

```bash
pnpm topics:verify                              # fails on RF < 3, missing brokers, bad partitions
docker compose exec kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka-1:9092 \
  --describe --unavailable-partitions           # leaderless partitions (Leader: none)
docker compose exec kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka-1:9092 \
  --describe --under-replicated-partitions      # ISR smaller than the replica set
docker compose exec kafka-1 /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka-1:9092 \
  --describe | grep -E '^Topic:.*ReplicationFactor: [12]\b'   # topics below RF 3
```

kafka-ui shows the same under **Brokers** (partitions, URP) and on each topic's **Overview**. Under-replicated partitions with RF=3 are expected while a broker restarts and clear on their own; RF below 3 never does.

### Restore leaders after a broker restart

Start the missing broker first (`docker compose --profile core up -d`); partitions whose only replica lives on it come back by themselves. If partitions stay `Leader: none` with all brokers up (KIP-966: the last replica is in the ELR and the controller will not elect it cleanly), force an election. Unclean election can lose writes that were not on the elected replica, so use it only to get a local cluster unstuck:

```bash
docker compose exec kafka-1 /opt/kafka/bin/kafka-leader-election.sh --bootstrap-server kafka-1:9092 \
  --election-type unclean --all-topic-partitions
```

### Repair an existing cluster created with RF=1 (keeps data)

All three brokers must be up and every partition must have a leader (previous step). Open a shell on a broker with `docker compose exec kafka-1 bash` and paste:

```bash
B=/opt/kafka/bin; BS=kafka-1:9092

# 1. Reassignment plan: every partition with fewer than 3 replicas gets 3, current leader first.
$B/kafka-topics.sh --bootstrap-server $BS --describe | awk -F'\t' '
  /Partition:/ {
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^Topic: /) t = substr($i, 8)
      else if ($i ~ /^Partition: /) p = substr($i, 12)
      else if ($i ~ /^Replicas: /) r = substr($i, 11)
    }
    if (split(r, reps, ",") >= 3) next
    list = reps[1]
    for (k = 1; k <= 2; k++) list = list "," ((reps[1] - 1 + k) % 3 + 1)
    out = out sep "{\"topic\":\"" t "\",\"partition\":" p ",\"replicas\":[" list "]}"; sep = ","
  }
  END { print "{\"version\":1,\"partitions\":[" out "]}" }' > /tmp/rf3.json
grep -o '"topic"' /tmp/rf3.json | wc -l   # partitions to move

# 2. Execute (it prints the current assignment: keep it for rollback), then repeat --verify
#    until every partition reports "completed".
$B/kafka-reassign-partitions.sh --bootstrap-server $BS --reassignment-json-file /tmp/rf3.json --execute
$B/kafka-reassign-partitions.sh --bootstrap-server $BS --reassignment-json-file /tmp/rf3.json --verify

# 3. Raise min.insync.replicas to 2 on every application topic (internal topics use the
#    broker default, already 2 on core).
for t in $($B/kafka-topics.sh --bootstrap-server $BS --list --exclude-internal); do
  $B/kafka-configs.sh --bootstrap-server $BS --alter --entity-type topics --entity-name "$t" \
    --add-config min.insync.replicas=2
done

# 4. Move leadership back to the preferred (first) replica.
$B/kafka-leader-election.sh --bootstrap-server $BS --election-type preferred --all-topic-partitions
```

The plan assumes broker ids 1, 2 and 3 (the `core` profile). Raise `min.insync.replicas` only after the reassignment has completed: with RF=1 and `min.insync.replicas=2`, every `acks=all` write fails with `NOT_ENOUGH_REPLICAS`. Finish with `pnpm topics:verify`, which must pass.

### Or start over (deletes all data)

If the data does not matter, [reset everything](#reset-everything) and bring the stack up again: `init-topics` waits for all three brokers and creates every topic with RF=3. That removes the Postgres volume too; to drop only Kafka's data:

```bash
docker compose --profile core down
docker volume rm fraudstream_kafka-1-data fraudstream_kafka-2-data fraudstream_kafka-3-data
docker compose --profile core up -d --wait
```

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
