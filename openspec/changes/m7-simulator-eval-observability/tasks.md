# Tasks

## 1. Simulator (SPEC §6.9)

- [ ] 1.1 Scaffold `apps/simulator` CLI with seeded PRNG, test-BIN PAN generator (Luhn) and account/merchant model; unit tests for Luhn validity and distribution parameters
- [ ] 1.2 `pnpm sim:seed --accounts N`: publish profiles and 30 days of compressed history via seed-only producer; integration test seeds 100 accounts and checks profiles materialized and baselines built
- [ ] 1.3 `pnpm sim:run --tps --duration --fraud-rate` HTTP load with rate control and idempotency keys, writing `ground_truth.csv`; test that rate stays within ±5% at 100 tps for 30 s
- [ ] 1.4 Scenarios `normal`, `card_testing`, `account_takeover`, `impossible_travel`, `merchant_compromise` with `--scenario`; unit tests on generated sequences for each scenario's defining properties

## 2. Evaluation and tuning (SPEC §9)

- [ ] 2.1 `scripts/eval.ts` + `pnpm eval`: metrics per scenario, undecided transactions listed separately, Markdown output into `docs/model.md`; unit tests for the metric math on a fixed confusion matrix
- [ ] 2.2 Run the reference simulation and tune `rules.yaml`, anomaly parameters and decision thresholds until SPEC §9.2 targets are met; record each iteration in `docs/model.md`
- [ ] 2.3 Add plain-language reason mapping review for explainability (SPEC §9.3); verify reasons shown for each scenario in the eval sample

## 3. Observability (SPEC §10)

- [ ] 3.1 Add OTel SDK bootstrap to `libs/observability` and import it first in every service; wire Kafka produce/consume spans with header propagation; integration test asserts one trace id across API → decision
- [ ] 3.2 Complete `/metrics` per service with SPEC §10 metrics; verify via Prometheus targets page all services are UP
- [ ] 3.3 `infra/docker-compose.observability.yml` (Jaeger, Prometheus, Grafana, kafka-exporter) with `observability` profile; verify services start and Jaeger shows a full trace
- [ ] 3.4 Provision Grafana datasources and 4 dashboards (`infra/grafana/dashboards/*.json`); verify they load on startup
- [ ] 3.5 Prometheus alert rules (lag, DLQ, outbox age, p95 latency); verify the DLQ rule fires after sending a poison message
- [ ] 3.6 Add `traceId`/`transactionId` to pino logs via OTel context; unit test of log mixin
- [ ] 3.7 Document observability in `docs/runbook.md` (where to look for lag, DLQ, slow decisions); verify links/ports are correct

## 4. Verification

- [ ] 4.1 Run the full quick start (SPEC §14.2) end to end and `pnpm eval`; confirm targets table in `docs/model.md`
- [ ] 4.2 Run `pnpm lint && pnpm typecheck && pnpm test`; CI green; tick every M7 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m7-simulator-eval-observability` after merge.
