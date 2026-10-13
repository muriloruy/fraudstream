# ADR-006: SSE vs WebSocket for the dashboard

- **Status:** accepted
- **Date:** 2026-10-13
- **Milestone:** M5 (SPEC §6.8, §17)

## Context

The analyst dashboard (M6) needs live updates:

- new and changed alerts (`alert.created`, `alert.updated`);
- a sample of decisions (`decision.made`);
- KPIs every 2 s (`metrics.tick`).

All traffic flows server → browser. The browser's own actions (assign, resolve) are ordinary REST calls that need validation, auditing and idempotent semantics anyway.

Constraints:

- Authentication must not put tokens in URLs. Query strings end up in access logs, proxies and browser history (SPEC §6.8).
- A slow browser must not make the gateway buffer without limit, and it must never miss an alert.
- A short network blip should not lose alerts.

## Decision

**Server-Sent Events on `GET /v1/stream`, authenticated by a dedicated short-lived httpOnly cookie.**

- **Authentication.** The dashboard keeps the access token in memory and calls `POST /auth/stream-session` with it. The gateway answers with a `fs_stream` cookie:
  - `HttpOnly; Secure; SameSite=Strict; Path=/v1/stream`, valid for 15 min;
  - a JWT with its own audience, so it cannot be replayed as an API bearer token, and an access token cannot open the stream.

  `EventSource` sends the cookie automatically, so no token appears in the URL. The session is checked when the stream opens. The server closes the stream when the session would expire, and the client requests a new cookie and reconnects. The refresh cookie is scoped to `/auth` and never reaches the stream.

- **Events.** Each event has a numeric `id` that increases monotonically, starting at the boot time in ms, so ids keep increasing across restarts. The `data` is a single line of JSON, so content cannot inject SSE fields. The stream sends `retry: 3000` as a reconnection hint.
- **Backpressure.** Each connection has a bounded queue (500 events) that is written only while the socket drains (`writableNeedDrain`). When the queue is full, `decision.made` samples and stale `metrics.tick` events are dropped, oldest first. `alert.*` events are never dropped, so a stuck client costs memory proportional to alerts only. The connection closes when the session ends at the latest.
- **Reconnection.** The last 1,000 alert events are kept in a ring buffer. A client that reconnects with `Last-Event-ID` receives the alert events it missed. Decisions and ticks are not replayed: they are samples, and the next tick supersedes the old ones.
- **Ordering with the database.** Alert events are published only after the consumer's DB transaction commits (`ctx.afterCommit` in the consumer runtime). A browser therefore never sees an alert that a rollback would remove.

## Alternatives considered

- **WebSocket.** It is bidirectional, but we have no client → server messages that REST does not already handle better. It brings drawbacks:
  - The browser WebSocket API cannot set headers, so authentication ends up in a query string, a first message, or a cookie anyway.
  - Some proxies need extra configuration for the `Upgrade` handshake.
  - Reconnection, resume and heartbeats would all be ours to build, whereas SSE has `Last-Event-ID` and automatic reconnect built in.

  Rejected for a one-way feed.

- **Token in the query string (`/v1/stream?token=…`).** This is common and simple, but the token leaks into access logs, proxy logs and `Referer` headers (SPEC §6.8). Rejected.
- **Long polling of `GET /v1/alerts`.** It is simple and stateless, but the latency is the polling interval and every client puts load on the queue query. Kept only as the fallback when the ring buffer cannot cover a gap: the dashboard reloads the queue over REST after a long disconnect.

## Consequences

- **Single instance.** Fan-out is in process, through an RxJS `Subject` per gateway instance. With several instances, an alert reaches only the clients of the instance that consumed the decision. The documented next step is `LISTEN/NOTIFY` on the gateway's database (the event is written in the same transaction as the alert) or a Kafka consumer group per instance. Fine for the local stack and M6.
- **Proxies must not buffer `text/event-stream`.** The gateway sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`, and the 2-second tick also keeps idle connections alive.
- **Tests.** Unit tests cover the queue policy (1,000 decisions and 5 alerts with a stuck reader keep every alert) and the resume window. An integration test receives `alert.created` after a REVIEW decision, gets 401 without the cookie, and resumes two missed alerts with `Last-Event-ID`.
