# live-event-stream Specification

## Purpose
Pushes alerts, sampled decisions and metrics to analysts' browsers in real time over a one-way authenticated stream.

## Requirements

### Requirement: Authenticated SSE stream
`GET /v1/stream` SHALL serve `text/event-stream` to authenticated analysts using cookie-based session auth, never a token in the query string (ADR-006).

#### Scenario: Unauthenticated stream
- **WHEN** a client opens the stream without a valid session cookie
- **THEN** the response is 401

### Requirement: Event types
The stream SHALL emit `alert.created`, `alert.updated`, sampled `decision.made`, and `metrics.tick` every 2 seconds.

#### Scenario: New alert pushed
- **WHEN** a REVIEW decision creates an alert
- **THEN** connected clients receive an `alert.created` event with the alert id

### Requirement: Backpressure
When a client's buffer grows beyond a limit, the stream SHALL drop `decision.made` samples but never drop `alert.*` events.

#### Scenario: Slow client
- **WHEN** a client stops reading while 1,000 decisions and 5 alerts occur
- **THEN** after it resumes it receives all 5 alert events and fewer than 1,000 decision samples

### Requirement: Reconnection
Events SHALL carry ids so a reconnecting client using `Last-Event-ID` can resume alert events missed during a short disconnect.

#### Scenario: Short disconnect
- **WHEN** a client reconnects with `Last-Event-ID` after missing two alerts
- **THEN** it receives the two missed `alert.created` events
