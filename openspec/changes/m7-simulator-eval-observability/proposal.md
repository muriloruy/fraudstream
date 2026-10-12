# Proposal

## Why

To claim the detector works, it must be measured against labeled traffic; to claim the platform is operable, a transaction must be traceable across every hop. Milestone M7 (SPEC §17) adds a realistic simulator with ground truth, a precision/recall evaluation meeting SPEC §9.2 targets, and the OpenTelemetry/Prometheus/Grafana stack.

## What Changes

- New CLI `apps/simulator`: `sim:seed` (profiles to `accounts.profiles.v1` + 30 days compressed history) and `sim:run` (HTTP traffic at a target TPS) with scenarios `normal`, `card_testing`, `account_takeover`, `impossible_travel`, `merchant_compromise`, writing `simulator_output/ground_truth.csv` (SPEC §6.9).
- `pnpm eval` computing precision, recall, F1, review/decline rates and false positive rate per scenario, results in `docs/model.md` (SPEC §9.1).
- Rule/scorer/fusion parameter tuning to meet SPEC §9.2.
- OpenTelemetry SDK in every service with trace propagation over Kafka headers; Jaeger, Prometheus, Grafana, kafka-exporter in `docker-compose.observability.yml`; provisioned dashboards and alert rules (SPEC §10).

Out of scope: LSTM autoencoder scorer (stretch §9.4).

## Capabilities

### New Capabilities
- `traffic-simulator`: generating realistic labeled payment traffic with injectable fraud scenarios.
- `detection-evaluation`: measuring detection quality per scenario against ground truth.
- `observability`: distributed tracing across Kafka, metrics, dashboards and alert rules.

### Modified Capabilities
<!-- none; parameter tuning changes config values, not the requirements of fraud-rules/anomaly-scoring/fraud-decision -->

## Impact

- New `apps/simulator`, `scripts/eval.ts`, `infra/docker-compose.observability.yml`, `infra/prometheus/`, `infra/grafana/`.
- `libs/observability` gains OTel setup; every service imports it first in `main.ts`.
- Config changes in `rules.yaml` and decision/anomaly env defaults after tuning.
