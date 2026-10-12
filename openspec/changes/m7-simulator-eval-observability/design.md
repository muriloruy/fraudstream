# Design

## Context

Full pipeline exists after M1–M6. See proposal.md and specs.

## Goals / Non-Goals

**Goals:** deterministic simulator (seeded RNG) so evaluation is reproducible; zero-config observability via compose profile.

**Non-Goals:** production alert routing (pager); ML model training.

## Decisions

- **Simulator** in TypeScript with a seeded PRNG (`--seed`); per-account lognormal amount parameters, Poisson inter-arrivals, home city, merchant pool with per-account favorites. Because the API stamps `requestedAt` server-side, historical traffic cannot go through it; history is produced by publishing synthetic `TransactionAuthorizationRequested` events (with test-only `requestedAt`) via a seed-only producer, consumed by rules/scorer to build baselines. Decision-engine output for seed traffic is tagged and excluded from eval.
- **Ground truth** appended by the HTTP client after a 202 using the returned `transactionId`.
- **Eval** reads `decision.decisions` through a read-only role and the CSV; outputs Markdown table appended to `docs/model.md` with model/ruleset/config versions.
- **Tuning loop**: adjust `rules.yaml` points/thresholds, anomaly weights and decision thresholds; each iteration recorded in `docs/model.md`.
- **OTel**: `@opentelemetry/sdk-node` with auto-instrumentation for http, pg and NestJS; manual spans for produce/consume using the M2 propagation helpers; OTLP HTTP to Jaeger (`OTEL_EXPORTER_OTLP_ENDPOINT`).
- **Metrics**: `prom-client` registry in `libs/observability`; Grafana dashboards as JSON in `infra/grafana/dashboards/`, datasources provisioned.

## Risks / Trade-offs

- [Seed-only producer bypasses ingestion] → only in the simulator, documented, events still validated by contracts; never enabled in production config.
- [Targets not met after tuning] → document results honestly in `docs/model.md` with analysis; tune per scenario.
