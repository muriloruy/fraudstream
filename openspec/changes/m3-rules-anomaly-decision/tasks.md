# Tasks

## 1. fraud-rules (SPEC §5.3, §6.4)

- [x] 1.1 Migrations `migrations/fraud_rules/` (account_profiles, account_activity, known_merchants, blocklist, processed_events, outbox) with index comments; verify with `pnpm db:migrate`
- [x] 1.2 Scaffold `apps/fraud-rules` and `rules.yaml` loader (Zod-validated, `rulesetVersion`); unit test rejects an invalid ruleset
- [x] 1.3 Implement R001–R010 as pure functions + haversine and score aggregation (`min(1, sum/100)`, hard decline); table-driven unit tests covering every boundary (5 vs 6 tx, 2 vs 3 small tx, 900 km/h, exactly 50% limit, 9 vs 10 history); coverage ≥ 85% on `domain/`
- [x] 1.4 Single-roundtrip context CTE in `infrastructure/db`; integration test asserts one query per transaction and correct aggregates on seeded data
- [x] 1.5 Profiles consumer for `accounts.profiles.v1` (upsert/tombstone); integration test for upsert and delete
- [x] 1.6 Transaction consumer: evaluate, insert activity + known merchant + outbox `FraudRulesEvaluated` in one transaction via M2 runtime; integration test for duplicate delivery → one result
- [x] 1.7 Activity cleanup job (> 30 days) and blocklist seed; integration test with backdated rows
- [ ] 1.8 Add service and its outbox relay to compose; verify results appear on `fraud.rule-results.v1`

## 2. anomaly-scorer (SPEC §5.4, §6.5)

- [ ] 2.1 Migrations `migrations/anomaly/` (account_baselines, contributions, known_merchants, processed_events, outbox); verify migration applies
- [ ] 2.2 Pure EWMA/z-score/logistic module and features; unit tests against a reference implementation (fixed sequences, tolerance 1e-9) and cold-start defaults by risk tier
- [ ] 2.3 Transaction consumer: score with prior baseline, then update baseline `FOR UPDATE`, store contribution, publish `AnomalyScored` via outbox; integration test for duplicate → sample size +1
- [ ] 2.4 Feedback consumer for `fraud.analyst-feedback.v1` reverting confirmed-fraud contributions; integration test compares with baseline computed without that transaction
- [ ] 2.5 Document scoring parameters and feedback strategy in `docs/model.md`
- [ ] 2.6 Add service and relay to compose; verify scores appear on `fraud.scores.v1`

## 3. decision-engine (SPEC §5.5, §6.6)

- [ ] 3.1 Migrations `migrations/decision/` (pending, decisions, processed_events, outbox) with index comments
- [ ] 3.2 Pure fusion module (weights by sample size, thresholds, hard decline, reasons in plain language, config version hash); table-driven unit tests at 0.3999/0.40/0.7499/0.75 and hard-decline override
- [ ] 3.3 Consumers for rule results and scores: upsert pending, decide when complete, write decision + delete pending + outbox in one transaction; integration tests for both arrival orders and duplicate parts
- [ ] 3.4 Timeout sweeper (250 ms, `SKIP LOCKED`, `partial = true`, REVIEW when rules missing, late parts ignored); integration test with only one part
- [ ] 3.5 Metrics `decision_latency_seconds` and `decisions_total{decision}`; verify on `/metrics`
- [ ] 3.6 Add service and relay to compose; verify decisions on `fraud.decisions.v1`

## 4. Transaction status (SPEC §3.3 step 8)

- [ ] 4.1 Add `processed_events` to `payments` and a `transaction-api-status` consumer updating status, `final_score`, `decided_at`; integration test for idempotent update and `GET` returning the decision

## 5. End-to-end and docs

- [ ] 5.1 E2E test (compose up + small test producer): `card_testing` burst for one account → `DECLINED` via API within 3 s (SPEC §13.4); add to CI `e2e` job (main and PRs labeled `e2e`)
- [ ] 5.2 Contract tests: producer fixtures of `FraudRulesEvaluated`, `AnomalyScored`, `FraudDecisionMade` validated against consumer schemas; add CI `contracts` job (SPEC §13.3)
- [ ] 5.3 Write ADR-005 (asynchronous 202 vs synchronous authorization, request/reply alternative)

## 6. Verification

- [ ] 6.1 Run `pnpm lint && pnpm typecheck && pnpm test`; CI green including `integration`, `contracts`, `e2e`
- [ ] 6.2 Tick every M3 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m3-rules-anomaly-decision` after merge. M0–M3 complete = publishable Kafka showcase (SPEC §17).
