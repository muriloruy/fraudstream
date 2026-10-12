# Design

## Context

All services exist (M1–M7). See proposal.md and specs.

## Goals / Non-Goals

**Goals:** reproducible measurements with machine specs recorded; automated chaos check runnable locally and optionally in CI (nightly).

**Non-Goals:** cloud deployment (stretch); 500 tx/s is a stretch target (reported, not required).

## Decisions

- **Large seed**: `generate_series` scripts per table, run against a dedicated database copy to avoid polluting demo data; `ANALYZE` before measuring; `EXPLAIN` captured before index (dropped) and after (recreated).
- **Load**: k6 with `constant-arrival-rate` executor and stages 50 → 200 → 500; PAN from test ranges; k6 summary JSON committed; decision latency read from Prometheus at the end.
- **Chaos**: `tests/chaos/run.sh` orchestrates `docker kill` at fixed offsets during a k6 run, waits for lag to drain, then runs `pnpm ledger:reconcile` and a decisions-vs-transactions count, exiting non-zero on any mismatch.
- **Images**: multi-stage Dockerfiles (pnpm deploy for pruned prod deps), `node:<lts>-alpine` or distroless runtime, `USER node`, size reported in CI.
- **Security CI**: CodeQL (JS/TS), `pnpm audit --prod --audit-level high`, gitleaks, Trivy on built images (fail on HIGH/CRITICAL with ignore file for accepted risks).

## Risks / Trade-offs

- [Laptop variability] → record CPU/RAM/Docker settings; run 3 times and report median.
- [Chaos test flakiness in CI] → run nightly, not on every PR.
