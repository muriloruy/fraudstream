# Spec Delta

## Purpose

Makes the system's behavior visible end to end — one trace per transaction across HTTP and Kafka hops, metrics with dashboards, and alert rules for the conditions that matter.

## ADDED Requirements

### Requirement: Distributed tracing across Kafka
Every service SHALL emit OpenTelemetry spans and propagate W3C `traceparent` through Kafka headers so one trace spans API → relay → rules/scorer → decision → ledger/alerts.

#### Scenario: Full trace
- **WHEN** one transaction is submitted and decided
- **THEN** Jaeger shows a single trace containing spans from all services involved

### Requirement: Service metrics
Every service SHALL expose `/metrics` with the metrics of SPEC §10 relevant to it, and consumer group lag SHALL be exported via kafka-exporter.

#### Scenario: HTTP histogram
- **WHEN** requests hit `transaction-api`
- **THEN** `http_request_duration_seconds` is reported by route and status

### Requirement: Provisioned dashboards
Grafana SHALL start with provisioned dashboards: Throughput & latency, Kafka lag, Fraud outcomes, Errors/DLQ.

#### Scenario: Dashboards on startup
- **WHEN** the observability profile starts
- **THEN** the four dashboards exist in Grafana without manual import

### Requirement: Alert rules
Prometheus SHALL load alert rules for lag > 10k for 2 min, DLQ rate > 0, outbox oldest unpublished > 30 s, and p95 decision latency > 1 s.

#### Scenario: DLQ alert fires
- **WHEN** a message is sent to any DLQ
- **THEN** the DLQ alert enters firing state

### Requirement: Structured logs without PII
Logs SHALL be JSON with `service`, `correlationId`, `transactionId` and `traceId`, and SHALL contain no PII.

#### Scenario: Log correlation
- **WHEN** a log line is emitted while processing a transaction
- **THEN** it carries the trace id of that transaction's trace
