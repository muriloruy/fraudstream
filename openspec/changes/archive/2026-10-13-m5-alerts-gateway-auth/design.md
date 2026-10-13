# Design

## Context

Consumes decisions (M3) and ledger entries (M4); reuses M2 runtime and the DLQ replay core from `scripts/dlq-replay.ts`. See proposal.md and specs.

## Goals / Non-Goals

**Goals:** secure-by-default auth; queue queries served by the partial index in SPEC §5.7; SSE that survives slow clients.

**Non-Goals:** SSO/MFA; multi-tenant analysts; WebSocket.

## Decisions

- **Passwords**: `argon2id` (memory 19 MiB, t=2, p=1 per OWASP); constant-time path for unknown emails (hash a dummy) to avoid user enumeration by timing.
- **Tokens**: access JWT (HS256, `JWT_ACCESS_SECRET`, 15 min) in memory on the client; refresh token = 32 random bytes, stored as sha256 in `auth.refresh_tokens` with a `family_id` column added to SPEC §5.7's table for reuse detection.
- **SSE auth**: the refresh cookie is scoped to `/auth`; a separate short-lived httpOnly `stream_session` cookie (scoped to `/v1/stream`) is issued by `POST /auth/stream-session` with the access token. Avoids tokens in URLs (ADR-006).
- **Keyset cursor**: base64url of `(final_score, created_at, alert_id)` with an HMAC to detect tampering; query `WHERE status IN (...) AND (final_score, created_at, alert_id) < ($1,$2,$3) ORDER BY final_score DESC, created_at, alert_id` — note mixed sort directions require rewriting the row comparison as an explicit predicate; index from SPEC §5.7 extended with `alert_id`.
- **Projections for timeline/metrics**: `alerts.account_events` (decisions + ledger postings, keep last 100 per account via periodic trim) and `alerts.decision_stats` (per-second buckets) fed by the consumers. Avoids cross-schema reads (least privilege).
- **SSE fan-out**: in-process event bus (RxJS Subject) per instance; each connection has a bounded queue (e.g., 500) with priority: alerts always enqueued, decisions dropped when full. Alerts kept in a ring buffer (last 1,000) for `Last-Event-ID` resume. Multi-instance fan-out (Postgres LISTEN/NOTIFY) documented as future work.
- **Resolution atomicity**: alert update + audit + outbox in one DB transaction; optimistic check `WHERE status IN ('OPEN','IN_PROGRESS')` gives 409 on double resolve.

## Risks / Trade-offs

- [Single-instance SSE bus] → acceptable locally; documented.
- [Mixed-direction keyset] → covered by pagination integration test.
