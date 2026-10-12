#!/usr/bin/env bash
# Creates (default) or verifies (--verify) every topic listed in topics.conf (SPEC §4.1).
#
# topics.conf is generated from libs/contracts (`pnpm topics:generate`), so the TypeScript
# constants and the cluster can never drift. Replication factor and min.insync.replicas are
# derived from the number of live brokers: 3 brokers -> RF 3 / ISR 2, 1 broker -> RF 1 / ISR 1.
set -euo pipefail

BOOTSTRAP="${BOOTSTRAP_SERVERS:-kafka-1:9092}"
CONF="${TOPICS_CONF:-$(dirname "$0")/topics.conf}"
BIN=/opt/kafka/bin
MODE="${1:-create}"

broker_count=$("$BIN/kafka-broker-api-versions.sh" --bootstrap-server "$BOOTSTRAP" 2>/dev/null | grep -c '(id:' || true)
if [[ "$broker_count" -lt 1 ]]; then
  echo "init-topics: no broker reachable at $BOOTSTRAP" >&2
  exit 1
fi
rf=$(( broker_count < 3 ? broker_count : 3 ))
min_isr=$(( rf < 2 ? 1 : 2 ))
echo "init-topics: $broker_count broker(s) -> replication.factor=$rf min.insync.replicas=$min_isr"

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
  if [[ $failures -gt 0 ]]; then
    echo "verify-topics: $failures of ${#specs[@]} topics do not match topics.conf" >&2
    exit 1
  fi
  echo "verify-topics: all ${#specs[@]} topics match topics.conf"
}

case "$MODE" in
  create) create ;;
  --verify) verify ;;
  *) echo "usage: $0 [--verify]" >&2; exit 2 ;;
esac
