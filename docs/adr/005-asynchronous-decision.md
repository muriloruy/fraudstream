# ADR-005: Asynchronous decision (202) vs synchronous authorization

- **Status:** accepted
- **Date:** 2026-10-12
- **Milestone:** M3 (SPEC §3.4, §17)

## Context

A real card authorization is synchronous. The acquirer waits for an approve/decline answer with a hard timeout, typically a few hundred milliseconds end to end. If the issuer does not answer in time, the network applies a stand-in decision. A fraud check that answers after that window is useless for that transaction.

FraudStream's goal is different (SPEC §1, §3.4). It is a showcase of event-driven patterns: transactional outbox, idempotent consumers, co-partitioned joins, retries and DLQ. The fraud decision comes from two independent services, `fraud-rules` and `anomaly-scorer`, whose results `decision-engine` joins by `transactionId`. Each hop is a Kafka topic fed by an outbox relay (ADR-004).

Measured on the compose stack in M3, the time from `POST /v1/transactions` to a persisted decision is about 170–260 ms. That covers three outbox relays polling every 100 ms, two consumer hops and the join. When one side is missing, `decision-engine` decides on partial data after a 2 s join timeout (SPEC §6.6).

## Decision

**`POST /v1/transactions` returns `202 Accepted` with `transactionId` and status `PENDING`, and the decision arrives asynchronously.** The client polls `GET /v1/transactions/:id`. A status consumer inside `transaction-api` (group `transaction-api-status`) applies `fraud.decisions.v1` to `payments.transactions`. Later milestones let analysts follow decisions via SSE (`alerts-gateway`, M5).

- The API's latency and availability do not depend on Kafka or the fraud services. A broker outage delays decisions but never fails or slows an authorization request: the outbox absorbs it.
- The decision is a durable event that the ledger, alerts and status consumers each consume independently, rather than a response held by one HTTP connection.
- Status updates are idempotent and monotonic: only `PENDING` rows are updated, so a redelivered decision is a no-op.

## Alternatives considered

- **Synchronous request/reply over Kafka (the realistic variant).** How it would work here:
  1. `transaction-api` writes the transaction and outbox row as today. It then waits on an in-memory map keyed by `transactionId`, with a **300 ms** deadline.
  2. Each API instance consumes a reply topic, `payments.authorization-replies.v1`. The request carries `reply-to` (instance id) and `correlation-id` headers.
  3. `decision-engine` also publishes a reply to that instance's partition, or the API instances share a group and forward replies they do not own.
  4. When a reply arrives within the deadline, it resolves the HTTP request with `200` and the decision. If the deadline passes, the API answers with a **stand-in decision** (approve below a configurable amount, otherwise decline or `REVIEW`) and the late decision only updates the record.

  This is closer to production. It also needs a sub-100 ms pipeline: the polling relays would have to go (Debezium CDC or `LISTEN/NOTIFY`), and the join timeout would drop from 2 s to well under 300 ms, so more decisions would be partial. Stateful reply routing makes scaling the API harder, and every Kafka hiccup becomes visible to clients as stand-in decisions. Rejected for now: it adds operational surface without teaching a new pattern central to the project. The design is kept here as the documented upgrade path.

- **Synchronous RPC chain (HTTP/gRPC from the API to rules, scorer and decision).** This is the lowest latency option and conceptually simple. But the API's availability becomes the product of every service's availability, retries can double-score, and Kafka's role shrinks to an audit log. Rejected: it removes the patterns the project exists to show.
- **Rules and scoring in-process in the API, Kafka only downstream.** This would be fast and synchronous. It couples deployment and scaling of the API with model and rule changes, and loses the independent consumer groups. Rejected for the same reason.

## Consequences

- Clients must poll or subscribe. The E2E suite (`tests/e2e`) shows a card-testing burst being `DECLINED` through `GET /v1/transactions/:id` well within the 3 s budget of SPEC §13.4.
- `PENDING` is a real state that clients and dashboards must handle. A transaction stays `PENDING` only while the pipeline is down; the decision lands when it recovers.
- Decision latency is tracked by the `decision_latency_seconds` histogram and alerted at p95 > 1 s (SPEC §11). It is the number to watch if a synchronous variant is ever needed.
- Relay polling dominates the latency budget. M3 found that idle relays backed off to 2 s per hop, which pushed decisions to about 3.7 s after a quiet spell. Relays now poll at a constant 100 ms while idle (ADR-004).
