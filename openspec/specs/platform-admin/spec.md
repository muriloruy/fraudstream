# platform-admin Specification

## Purpose
Gives administrators audited operational controls over the event pipeline from the gateway, without shell access to Kafka.

## Requirements

### Requirement: DLQ replay endpoint
`POST /admin/dlq/replay` SHALL replay a DLQ offset range (with optional dry run) for admins only and write a `DLQ_REPLAYED` audit entry.

#### Scenario: Admin replays
- **WHEN** an admin replays a range
- **THEN** the messages are republished to the original topic and an audit row records the range

### Requirement: Consumer lag
`GET /admin/consumers/lag` SHALL return lag per consumer group, topic and partition from the Kafka admin API, for admins only.

#### Scenario: Lag reported
- **WHEN** an admin calls the endpoint while a consumer is stopped
- **THEN** that group shows positive lag
