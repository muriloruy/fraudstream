# Tasks

## 1. Database performance (SPEC §5.8)

- [ ] 1.1 Write `scripts/seed-large.sql` (10M+ rows for `alerts.alerts`, `payments.transactions`, `fraud_rules.account_activity`) and `pnpm db:seed-large`; verify row counts
- [ ] 1.2 Capture `EXPLAIN (ANALYZE, BUFFERS)` before/after for alert queue, account history and velocity window (incl. the single-roundtrip rule context CTE); write `docs/perf.md` with query, index rationale and timings
- [ ] 1.3 Benchmark `account_activity` cleanup: batched `DELETE` vs daily partitions with `DROP`; record results and the chosen approach in `docs/perf.md`

## 2. Load (SPEC §11, §13.6)

- [ ] 2.1 k6 script `tests/load/transactions.js` (50 → 200 → 500 tx/s, thresholds for errors and latency); verify it runs against compose
- [ ] 2.2 Run sustained 200 tx/s for 10 min, record throughput, p95/p99 decision latency and machine specs in `docs/perf.md`; tune `linger.ms`/batch size and compare `eachMessage` vs `eachBatch`, documenting results
- [ ] 2.3 Scale `fraud-rules` to 3 replicas; verify 4 partitions each and record throughput gain
- [ ] 2.4 Backlog test: stop `fraud-rules`, accumulate 100k messages, restart; record drain time (< 2 min)

## 3. Chaos (SPEC §13.6)

- [ ] 3.1 `tests/chaos/run.sh`: during load kill one broker, one `fraud-rules` replica, then `ledger`; after recovery assert decisions = accepted transactions, `pnpm ledger:reconcile` clean; verify it exits 0 on a healthy run and non-zero when a journal is deleted
- [ ] 3.2 Add a nightly CI workflow running the chaos test in `lowmem`-compatible mode or document why it runs locally only

## 4. Build and CI hardening (SPEC §15)

- [ ] 4.1 Multi-stage, non-root Dockerfiles for every app; CI `build-images` job reporting image sizes; verify `docker run --user` shows non-root
- [ ] 4.2 CI `security` job: CodeQL, `pnpm audit --prod --audit-level high`, gitleaks, Trivy image scan; verify each runs on the PR

## 5. Documentation (SPEC §16, §19)

- [ ] 5.1 Write ADR-001 (Kafka vs RabbitMQ) and review ADR-002..009 against measured results (e.g. update ADR-003/004 with load numbers) so the index is complete
- [ ] 5.2 Write `docs/security/threat-model.md` (STRIDE per service and data flow) and a code review checklist
- [ ] 5.3 Complete `docs/runbook.md` (replay DLQ, handle lag, rotate keys, reset environment)
- [ ] 5.4 Final `README.md` following SPEC §19: pitch + badges, dashboard GIF, Mermaid architecture, Kafka/Security/DB/Fraud/Performance sections with links to code, PCI DSS disclaimer, quick start, Figma link + screenshots, ADR index, "what I would do next"

## 6. Verification

- [ ] 6.1 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:security`; CI green
- [ ] 6.2 Tick every M8 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m8-performance-chaos-docs` after merge. Stretch items (SPEC §17) become new changes when picked up.
