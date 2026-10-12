# Spec Delta

## Purpose

Makes poison messages visible and recoverable: they are moved aside with full diagnostics instead of blocking a partition, and can be replayed safely once the cause is fixed.

## ADDED Requirements

### Requirement: Permanent errors go straight to DLQ
Schema validation failures, unknown event versions and broken business invariants SHALL be published directly to `<topic>.<group>.dlq` without retries, and the partition SHALL keep flowing (SPEC §4.6).

#### Scenario: Invalid payload
- **WHEN** a message that fails schema validation is consumed
- **THEN** it lands in the DLQ once and the next message on the partition is processed

### Requirement: DLQ diagnostics
A DLQ message SHALL keep the original payload, key and headers, and add `dlq-reason`, `dlq-error-message`, `original-topic`, `original-partition`, `original-offset` and `failed-at`.

#### Scenario: Headers on DLQ message
- **WHEN** a DLQ message is inspected
- **THEN** all six diagnostic headers are present and the key equals the original key

### Requirement: Replay CLI
`pnpm dlq:replay --topic <dlq> --from <offset> --to <offset> [--dry-run]` SHALL republish the selected DLQ messages to their original topic with original key and headers; `--dry-run` SHALL only list them.

#### Scenario: Dry run
- **WHEN** the CLI runs with `--dry-run`
- **THEN** it prints the messages in range and publishes nothing

#### Scenario: Replay is safe to repeat
- **WHEN** the same range is replayed twice after the bug is fixed
- **THEN** each event's side effect exists exactly once
