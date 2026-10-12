# FraudStream — instructions for Claude Code

- Read docs/SPEC.md before any task. Follow its section numbers when referring to requirements.
- Planning lives in OpenSpec (`openspec/`). Each milestone (SPEC §17) is one change under `openspec/changes/mN-*`; implement it with `/opsx:apply <change>` and archive it with `/opsx:archive` when its checklist is green.
- Work one milestone at a time (SPEC §17). Do not start the next milestone until the current checklist is green.
- TypeScript strict. No `any`. Domain code (rules, scoring, fusion, money) must not import NestJS or Kafka.
- SQL: parameterized only, migrations per service under migrations/<service>/. Every new index needs a comment with the query it serves.
- Kafka: never enable auto-commit; commit offsets only after the DB transaction commits. All consumers use libs/kafka idempotent handler.
- Never log, persist outside card-vault, or put in Kafka a PAN or CVV. Run `pnpm test:security` after touching ingestion.
- Money is a decimal string / numeric(18,2). Never use floating point for amounts.
- Add or update tests with every change: unit for domain, integration (Testcontainers) for Kafka/DB behavior.
- Run `pnpm lint && pnpm typecheck && pnpm test` before declaring a task done.
- Commit messages: Conventional Commits.
