#!/usr/bin/env bash
# Checks that the running cluster matches infra/kafka/topics.conf (partitions, replication
# factor, cleanup policy, retention, min.insync.replicas). Exits non-zero on any mismatch.
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
  -v "$PWD/infra/kafka:/infra/kafka:ro" \
  --entrypoint /bin/bash apache/kafka:4.1.0 /infra/kafka/init-topics.sh --verify
