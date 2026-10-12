# Architecture Decision Records

Decisions a reviewer might question, one page each (SPEC §16). New ADRs start from [`template.md`](template.md).

| ADR                                        | Title                                                       | Status       |
| ------------------------------------------ | ----------------------------------------------------------- | ------------ |
| 001                                        | Kafka instead of RabbitMQ                                   | planned (M8) |
| [002](002-co-partitioning-by-account.md)   | Co-partitioning by `accountId` with 12 partitions           | accepted     |
| [003](003-kafka-client-library.md)         | Kafka client library choice                                 | accepted     |
| [004](004-transactional-outbox.md)         | Transactional outbox (polling) vs Kafka transactions vs CDC | accepted     |
| [005](005-asynchronous-decision.md)        | Asynchronous decision (202) vs synchronous authorization    | accepted     |
| 006                                        | SSE vs WebSocket for the dashboard                          | planned (M5) |
| [007](007-consumer-state-in-postgresql.md) | PostgreSQL for consumer state vs Redis vs Kafka Streams     | accepted     |
| [008](008-tokenization-vault.md)           | Tokenization vault design                                   | accepted     |
| [009](009-money-representation.md)         | Money representation                                        | accepted     |
