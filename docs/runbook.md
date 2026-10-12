# Runbook

Operational procedures for the local environment. Later milestones add DLQ replay, lag handling and key rotation (SPEC §17 M8).

## Start and stop

```bash
cp .env.example .env                           # first time only
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
