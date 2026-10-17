#!/usr/bin/env bash
# Creates (default) or verifies (--verify) every topic listed in topics.conf (SPEC §4.1).
#
# topics.conf is generated from libs/contracts (`pnpm topics:generate`), so the TypeScript
# constants and the cluster can never drift.
#
# Replication factor and min.insync.replicas follow the number of brokers the cluster is
# *meant* to have, never the number that happens to answer right now: 3 brokers -> RF 3 /
# ISR 2 (`core`), 1 broker -> RF 1 / ISR 1 (`lowmem`). The expected count is EXPECTED_BROKERS
# when set, otherwise the size of the KRaft voter set (every node is broker+controller, and
# the voter set is static config: 3 in `core`, 1 in `lowmem`). Before creating or verifying
# anything the script waits, up to BROKER_WAIT_TIMEOUT seconds, until that many unfenced
# brokers are registered, so a broker that is still starting can never produce RF=1 topics.
set -euo pipefail

BOOTSTRAP="${BOOTSTRAP_SERVERS:-kafka-1:9092}"
CONF="${TOPICS_CONF:-$(dirname "$0")/topics.conf}"
BIN=/opt/kafka/bin
MODE="${1:-create}"
WAIT_TIMEOUT="${BROKER_WAIT_TIMEOUT:-180}"

# Number of nodes in the KRaft voter set, or nothing if the quorum cannot be described yet.
# Handles both output formats: `[{"id": 1, ...}, ...]` (Kafka >= 3.9) and `[1,2,3]`.
voter_count() {
  local voters
  voters=$("$BIN/kafka-metadata-quorum.sh" --bootstrap-server "$BOOTSTRAP" describe --status 2>/dev/null |
    sed -n 's/^CurrentVoters:[[:space:]]*//p') || return 0
  [[ -n "$voters" ]] || return 0
  if [[ "$voters" == *'"id"'* ]]; then
    grep -o '"id"' <<<"$voters" | wc -l
  else
    grep -oE '[0-9]+' <<<"$voters" | wc -l
  fi
}

# Number of registered, unfenced brokers as seen by the bootstrap broker.
live_broker_count() {
  "$BIN/kafka-broker-api-versions.sh" --bootstrap-server "$BOOTSTRAP" 2>/dev/null |
    grep -c '(id: .*isFenced: false' || true
}

if [[ -n "${EXPECTED_BROKERS:-}" && ! "$EXPECTED_BROKERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "init-topics: EXPECTED_BROKERS must be a positive integer, got '$EXPECTED_BROKERS'" >&2
  exit 2
fi

expected="${EXPECTED_BROKERS:-}"
expected_source="EXPECTED_BROKERS"
live=0
deadline=$((SECONDS + WAIT_TIMEOUT))
while :; do
  if [[ -z "$expected" ]]; then
    expected=$(voter_count)
    expected_source="KRaft voter set"
  fi
  live=$(live_broker_count)
  # --verify reports a missing broker as a problem instead of waiting for it.
  if [[ -n "$expected" && ("$live" -ge "$expected" || "$MODE" == "--verify") ]]; then
    break
  fi
  if [[ $SECONDS -ge $deadline ]]; then
    if [[ -z "$expected" ]]; then
      echo "init-topics: could not describe the KRaft quorum at $BOOTSTRAP within ${WAIT_TIMEOUT}s;" \
        "set EXPECTED_BROKERS to the number of brokers this cluster should have" >&2
    else
      echo "init-topics: only $live of $expected expected broker(s) ($expected_source) registered at" \
        "$BOOTSTRAP after ${WAIT_TIMEOUT}s; refusing to continue with fewer brokers than the" \
        "cluster is meant to have (topics would get a lower replication factor)." \
        "Check 'docker compose ps' for brokers that are down or unhealthy." >&2
    fi
    exit 1
  fi
  echo "init-topics: waiting for brokers (${live} of ${expected:-?} registered)"
  sleep 3
done

rf=$((expected < 3 ? expected : 3))
min_isr=$((rf < 2 ? 1 : 2))
echo "init-topics: $live of $expected expected broker(s) ($expected_source) ->" \
  "replication.factor=$rf min.insync.replicas=$min_isr"

mapfile -t specs < <(grep -vE '^\s*(#|$)' "$CONF")

create() {
  local existing
  existing=$("$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --list)
  local missing=()
  for spec in "${specs[@]}"; do
    read -r name _ <<<"$spec"
    grep -qxF "$name" <<<"$existing" || missing+=("$spec")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "init-topics: all ${#specs[@]} topics already exist, nothing to do"
    return
  fi
  echo "init-topics: creating ${#missing[@]} of ${#specs[@]} topics"
  # Each kafka-topics.sh call starts a JVM; create in batches of 6 to keep startup short.
  local pids=() failed=0
  for spec in "${missing[@]}"; do
    create_one "$spec" &
    pids+=($!)
    if [[ ${#pids[@]} -eq 6 ]]; then
      for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
      pids=()
    fi
  done
  for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
  if [[ $failed -ne 0 ]]; then
    echo "init-topics: some topics could not be created" >&2
    exit 1
  fi
}

create_one() {
  local name partitions policy retention
  read -r name partitions policy retention <<<"$1"
  local args=(--create --if-not-exists --topic "$name" --partitions "$partitions"
    --replication-factor "$rf" --config "cleanup.policy=$policy"
    --config "min.insync.replicas=$min_isr")
  if [[ "$retention" != "-1" ]]; then
    args+=(--config "retention.ms=$retention")
  fi
  "$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" "${args[@]}" >/dev/null
  echo "  + $name"
}

verify() {
  local describe failures=0
  describe=$("$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --describe | grep -E '^Topic:')
  for spec in "${specs[@]}"; do
    read -r name partitions policy retention <<<"$spec"
    line=$(awk -F'\t' -v topic="Topic: $name" '$1 == topic' <<<"$describe")
    problems=()
    if [[ -z "$line" ]]; then
      problems+=("missing")
    else
      [[ "$line" == *"PartitionCount: $partitions"$'\t'* ]] || problems+=("partitions != $partitions")
      [[ "$line" == *"ReplicationFactor: $rf"$'\t'* ]] || problems+=("replication.factor != $rf")
      [[ "$line" == *"cleanup.policy=$policy"* ]] || problems+=("cleanup.policy != $policy")
      [[ "$line" == *"min.insync.replicas=$min_isr"* ]] || problems+=("min.insync.replicas != $min_isr")
      if [[ "$retention" != "-1" && "$line" != *"retention.ms=$retention"* ]]; then
        problems+=("retention.ms != $retention")
      fi
    fi
    if [[ ${#problems[@]} -gt 0 ]]; then
      failures=$((failures + 1))
      echo "  ✗ $name: ${problems[*]}"
    else
      echo "  ✓ $name"
    fi
  done

  # Every topic on the cluster, including internal ones (__consumer_offsets,
  # __transaction_state) and any not in topics.conf, must reach the expected RF.
  local low_rf
  low_rf=$(awk -F'\t' -v rf="$rf" '{
      name = $1; sub(/^Topic: /, "", name)
      for (i = 2; i <= NF; i++) if ($i ~ /^ReplicationFactor: /) {
        n = $i; sub(/^ReplicationFactor: /, "", n)
        if (n + 0 < rf + 0) print "  ✗ " name ": replication.factor " n " < " rf
      }
    }' <<<"$describe")
  if [[ -n "$low_rf" ]]; then
    echo "$low_rf"
    failures=$((failures + $(wc -l <<<"$low_rf")))
  fi

  if [[ "$live" -lt "$expected" ]]; then
    echo "  ✗ only $live of $expected expected broker(s) are registered"
    failures=$((failures + 1))
  fi

  # Partition health: no leaderless partitions, no partitions with a shrunken ISR.
  local unavailable under
  unavailable=$("$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --describe \
    --unavailable-partitions 2>/dev/null | grep -c 'Partition:' || true)
  under=$("$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --describe \
    --under-replicated-partitions 2>/dev/null | grep -c 'Partition:' || true)
  if [[ "$unavailable" -gt 0 ]]; then
    echo "  ✗ $unavailable partition(s) have no leader (see docs/runbook.md, Kafka replication)"
    failures=$((failures + 1))
  fi
  if [[ "$under" -gt 0 ]]; then
    echo "  ✗ $under partition(s) are under-replicated (see docs/runbook.md, Kafka replication)"
    failures=$((failures + 1))
  fi

  if [[ $failures -gt 0 ]]; then
    echo "verify-topics: $failures problem(s) found (expected replication.factor=$rf" \
      "min.insync.replicas=$min_isr for $expected broker(s))" >&2
    exit 1
  fi
  echo "verify-topics: all ${#specs[@]} topics match topics.conf, every topic has" \
    "replication.factor >= $rf, no leaderless or under-replicated partitions"
}

case "$MODE" in
  create) create ;;
  --verify) verify ;;
  *) echo "usage: $0 [--verify]" >&2; exit 2 ;;
esac
