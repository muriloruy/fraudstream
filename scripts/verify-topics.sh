#!/usr/bin/env bash
# Checks that the running cluster matches infra/kafka/topics.conf (partitions, replication
# factor, cleanup policy, retention, min.insync.replicas) and is healthy. Exits non-zero on
# any mismatch, on any topic (internal ones included) with a replication factor below the
# expected one (3 on the 3-broker `core` cluster, 1 on `lowmem`), and on any leaderless or
# under-replicated partition. The expected broker count comes from the cluster's KRaft
# voter set; set EXPECTED_BROKERS to override it.
#
# Usage: pnpm topics:verify   (with the compose stack running, any Kafka profile)
set -euo pipefail
cd "$(dirname "$0")/.."

network=$(docker network ls --filter name=fraudstream_default --format '{{.Name}}' | head -n1)
if [[ -z "$network" ]]; then
  echo "verify-topics: compose stack is not running (docker compose --profile core up -d)" >&2
  exit 1
fi

exec docker run --rm --network "$network" \
  -e BOOTSTRAP_SERVERS=kafka-1:9092 \
  -e EXPECTED_BROKERS="${EXPECTED_BROKERS:-}" \
  -e BROKER_WAIT_TIMEOUT="${BROKER_WAIT_TIMEOUT:-30}" \
  -v "$PWD/infra/kafka:/infra/kafka:ro" \
  --entrypoint /bin/bash apache/kafka:4.1.0 /infra/kafka/init-topics.sh --verify
