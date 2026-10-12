# Tasks

## 1. Schemas (SPEC §5.7)

- [ ] 1.1 Migrations `migrations/auth/` (users, refresh_tokens with `family_id`) and `migrations/alerts/` (alerts, audit_log, account_events, decision_stats, processed_events, outbox) with index comments; `REVOKE UPDATE, DELETE` on `audit_log`; verify with `pnpm db:migrate` and a permission test
- [ ] 1.2 Seed script for demo users (`analyst@demo.local`, `admin@demo.local`) with passwords from `.env`; verify login works after seeding

## 2. Authentication and RBAC (SPEC §6.8, §7 Req. 8)

- [ ] 2.1 Scaffold `apps/alerts-gateway` (helmet, CORS allow-list, cookie-parser, Problem Details, Swagger at `/docs`); verify OpenAPI JSON is served
- [ ] 2.2 Login with argon2id, generic errors, dummy-hash timing, lockout 5/15 min, throttling 10/min, audit `LOGIN`/`LOGIN_FAILED`; integration tests for success, wrong password, unknown email, lockout and 429
- [ ] 2.3 Refresh rotation with family reuse detection and logout; integration tests for rotation, reuse → family revoked, refresh after logout → 401
- [ ] 2.4 JWT guard + `@Roles()` guard; AuthZ matrix test covering every endpoint × {anonymous, analyst, admin} (SPEC §13.5)

## 3. Alerts (SPEC §6.8)

- [ ] 3.1 Decision consumer creating alerts (REVIEW/DECLINE) with snapshot, plus projections `account_events` and `decision_stats`; ledger consumer feeding `account_events`; integration tests for duplicate decisions → one alert and APPROVE → none
- [ ] 3.2 `GET /v1/alerts` with filters and HMAC-signed keyset cursor; integration test pages 250 alerts with concurrent inserts (no duplicates/skips) and tampered cursor → 400; record `EXPLAIN` of the queue query for `docs/perf.md`
- [ ] 3.3 `GET /v1/alerts/:id` with `ALERT_VIEWED` audit; `POST /assign`; `POST /resolve` (verdict + required note) updating alert + audit + outbox `AnalystFeedbackRecorded` atomically, 409 on double resolve; integration tests for each
- [ ] 3.4 `GET /v1/accounts/:accountId/timeline` and `GET /v1/metrics/summary?window=15m`; integration tests with seeded projections
- [ ] 3.5 Add service and alerts relay to compose; verify feedback reaches `fraud.analyst-feedback.v1` and the anomaly scorer consumes it

## 4. SSE stream (SPEC §6.8, ADR-006)

- [ ] 4.1 `POST /auth/stream-session` cookie and `GET /v1/stream` with event types, 2 s `metrics.tick`, event ids; integration test receives `alert.created` after a REVIEW decision and 401 without cookie
- [ ] 4.2 Per-connection bounded queue with priority (drop decisions, keep alerts) and `Last-Event-ID` resume from ring buffer; unit tests for the queue policy and resume
- [ ] 4.3 Write ADR-006 (SSE vs WebSocket, auth, proxies, reconnection)

## 5. Admin endpoints

- [ ] 5.1 `POST /admin/dlq/replay` reusing the replay core (dry run supported, `DLQ_REPLAYED` audit) and `GET /admin/consumers/lag` via Kafka admin API; integration tests for admin success and analyst 403

## 6. Security and verification

- [ ] 6.1 Extend `pnpm test:security` with brute-force lockout, refresh reuse and SQL-injection payloads on gateway string inputs (SPEC §13.5); verify green
- [ ] 6.2 Run `pnpm lint && pnpm typecheck && pnpm test`; CI green; tick every M5 acceptance item in SPEC §17

## Workflow follow-up

- Archive with `/opsx:archive m5-alerts-gateway-auth` after merge.
