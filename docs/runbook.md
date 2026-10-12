# Runbook

Operational procedures for the local environment. Later milestones add DLQ replay and lag handling (SPEC §17 M8).

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
