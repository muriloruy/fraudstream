# Proposal

## Why

The project's claims — throughput, latency, no loss, no duplicates, query optimization at scale — must be measured, not assumed (SPEC §11). Milestone M8 (SPEC §17) produces that evidence and the final documentation recruiters and reviewers read.

## What Changes

- `scripts/seed-large.sql` (10M+ rows) and `docs/perf.md` with `EXPLAIN (ANALYZE, BUFFERS)` before/after for the alert queue, account history and velocity window queries, plus the `account_activity` cleanup comparison (delete vs daily partitions) (SPEC §5.8, §5.3).
- k6 load test ramping 50 → 200 → 500 tx/s; results and tuning (batch size, `eachBatch` vs `eachMessage`) in `docs/perf.md` (SPEC §13.6, §11).
- Chaos test: kill one broker, one `fraud-rules` replica and `ledger` during load; reconciliation must be clean (SPEC §13.6).
- Horizontal scaling check with 3 `fraud-rules` replicas and 100k backlog recovery (SPEC §11).
- Remaining CI security jobs: CodeQL, `pnpm audit`, gitleaks, Trivy; multi-stage non-root Docker images (SPEC §15).
- Figma file mirroring the design tokens, with the 4 screens + Login in light/dark, compared side by side with the implementation (moved from M6; SPEC §8.1).
- Docs: all ADRs 001–009, `docs/security/threat-model.md` (STRIDE), `docs/runbook.md`, final README per SPEC §19 with PCI DSS disclaimer.

## Capabilities

### New Capabilities
- `system-resilience`: guarantees under failure — no loss, no duplicate journals, recovery time, horizontal scaling.
- `performance-benchmarks`: measured throughput/latency targets and documented query optimization.

### Modified Capabilities
<!-- none; `ci-pipeline` gains jobs already foreseen by SPEC §15 — recorded as tasks, the gate requirement is unchanged -->

## Impact

- `tests/load/` (k6), `tests/chaos/`, `scripts/seed-large.sql`, Dockerfiles for all apps, `.github/workflows/ci.yml` (security + build-images jobs), `docs/**`, `README.md`.
