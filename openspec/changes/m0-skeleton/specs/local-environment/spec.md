# Spec Delta

## Purpose

Provides a reproducible local runtime (Kafka cluster, PostgreSQL and inspection UI) so that every service and test can run on a laptop with Docker only, without any cloud account.

## ADDED Requirements

### Requirement: Core stack starts with one command
The repository SHALL provide a Docker Compose definition whose `core` profile starts 3 Kafka brokers in KRaft mode (no ZooKeeper), PostgreSQL 16+, kafka-ui and the topic initializer, with no manual steps besides copying `.env.example` to `.env` (SPEC §14.1, §14.2).

#### Scenario: Fresh clone boots the stack
- **WHEN** a developer runs `cp .env.example .env` and `docker compose --profile core up -d` on a fresh clone
- **THEN** all 3 brokers, PostgreSQL and kafka-ui report healthy and kafka-ui at `http://localhost:8080` lists the cluster with 3 brokers

#### Scenario: Topic initializer finishes before services
- **WHEN** the core stack starts
- **THEN** the `init-topics` container exits with status 0 after all brokers are healthy

### Requirement: Low-memory profile
The Compose definition SHALL provide a `lowmem` profile that runs a single broker with replication factor 1 and `min.insync.replicas=1` (SPEC §14.1).

#### Scenario: Single-broker boot
- **WHEN** a developer runs `docker compose --profile lowmem up -d`
- **THEN** one broker starts and every topic from the catalogue exists with replication factor 1

### Requirement: Per-service database isolation
PostgreSQL SHALL be initialized with one schema per service (`payments`, `vault`, `fraud_rules`, `anomaly`, `decision`, `ledger`, `alerts`, `auth`) and one login role per service that can only access its own schema (SPEC §5).

#### Scenario: Role cannot read another schema
- **WHEN** the `payments_svc` role runs `SELECT` on any table in the `vault` schema
- **THEN** PostgreSQL rejects the query with a permission error

#### Scenario: Role owns its schema
- **WHEN** the `payments_svc` role creates a table in the `payments` schema
- **THEN** the statement succeeds

### Requirement: Secrets are never committed
The repository SHALL ship a `.env.example` containing only placeholder values for every variable in SPEC §14.3, and `.env` SHALL be ignored by git.

#### Scenario: Real env file is ignored
- **WHEN** a developer creates `.env` and runs `git status`
- **THEN** `.env` is not listed as an untracked file
