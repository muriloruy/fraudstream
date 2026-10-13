# Proposal

## Why

Suspicious transactions are only useful if analysts can triage them securely. Milestone M5 (SPEC §17) delivers the backend for the analyst dashboard: authentication with PCI DSS-inspired controls, the alert queue and resolution flow (which closes the feedback loop to the anomaly scorer), an audit trail, and a real-time stream.

## What Changes

- New service `alerts-gateway` (HTTP + consumer) (SPEC §6.8):
  - Auth: login with argon2id, lockout after 5 failures for 15 min, 15-min JWT access token, refresh token rotation in httpOnly cookie with reuse detection, logout, RBAC (`analyst`, `admin`) (SPEC §5.7, §7 Req. 8).
  - Alerts: consume `fraud.decisions.v1` (REVIEW/DECLINE) and `ledger.entries.v1`, keyset-paginated queue, detail with audit, assign, resolve → `fraud.analyst-feedback.v1` via outbox; account timeline; metrics summary.
  - SSE `/v1/stream` with cookie auth and backpressure (ADR-006).
  - Admin: DLQ replay endpoint (audited) and consumer lag.
- Append-only `alerts.audit_log`.
- AuthZ matrix, brute-force and refresh-reuse security tests (SPEC §13.5).
- OpenAPI spec via `@nestjs/swagger` for the web app (SPEC §8.3).

Out of scope: the web UI (M6).

## Capabilities

### New Capabilities
- `analyst-auth`: analyst/admin authentication, session lifecycle and role-based authorization.
- `alert-management`: creating alerts from decisions, the triage queue, assignment, resolution with feedback, account timeline and audit trail.
- `live-event-stream`: server-sent events feeding the dashboard with alerts, decisions and metrics.
- `platform-admin`: admin-only operational endpoints (DLQ replay, consumer lag).

### Modified Capabilities
<!-- none -->

## Impact

- New app `alerts-gateway`; migrations `migrations/alerts/`, `migrations/auth/`; relay instance for `alerts`.
- Dependencies: `argon2`, `@nestjs/jwt`, `@nestjs/swagger`, `cookie-parser`, `@nestjs/throttler`.
- The gateway needs read access to decision/ledger data for timelines: served from its own projections fed by topics, not cross-schema reads.
