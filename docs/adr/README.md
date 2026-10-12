# Architecture Decision Records

Decisions a reviewer might question, one page each (SPEC §16). New ADRs start from [`template.md`](template.md).

| ADR                                      | Title                                                       | Status                        |
| ---------------------------------------- | ----------------------------------------------------------- | ----------------------------- |
| 001                                      | Kafka instead of RabbitMQ                                   | planned (M8)                  |
| [002](002-co-partitioning-by-account.md) | Co-partitioning by `accountId` with 12 partitions           | accepted                      |
| [003](003-kafka-client-library.md)       | Kafka client library choice                                 | proposed (decision due in M1) |
| 004                                      | Transactional outbox (polling) vs Kafka transactions vs CDC | planned (M1)                  |
| 005                                      | Asynchronous decision (202) vs synchronous authorization    | planned (M3)                  |
| 006                                      | SSE vs WebSocket for the dashboard                          | planned (M5)                  |
| 007                                      | PostgreSQL for consumer state vs Redis vs Kafka Streams     | planned (M2)                  |
| 008                                      | Tokenization vault design                                   | planned (M1)                  |
| 009                                      | Money representation                                        | planned (M1)                  |
