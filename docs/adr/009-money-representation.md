# ADR-009: Money representation

- **Status:** accepted
- **Date:** 2026-10-12
- **Milestone:** M1 (SPEC §4.9, §5)

## Context

Amounts flow from the API through Kafka into rules, the ledger and the dashboard. IEEE-754 doubles cannot represent most decimal fractions (`0.1 + 0.2 !== 0.3`), and JSON parsers turn numbers into doubles by default. A rounding error in a ledger or a limit check is a correctness bug, and in payments it is also an audit finding.

## Decision

- **On the wire (HTTP and Kafka): decimal strings** with at most two decimals, e.g. `"1250.90"`, always paired with an ISO 4217 currency. `libs/contracts` rejects JSON numbers for money (`DecimalString`, `Money`), so a float cannot even enter the system.
- **In PostgreSQL: `numeric(18,2)`.** Values are bound from the decimal string, and `pg` returns `numeric` as a string, so no double is created on the way in or out.
- **In code: exact arithmetic.** Integer cents as `bigint` via `toCents()` for comparisons and sums (amount limits, ledger balance checks); `decimal.js` in domain code that needs division or ratios (rules, M3).
- **Scores are not money.** Rule and anomaly scores are plain numbers in `[0, 1]` and are stored as `numeric(5,4)`.

## Alternatives considered

- **Integer minor units on the wire** (`125090`): exact and compact, but every reader must know the currency exponent (JPY has 0, BHD has 3) and humans misread it in logs and tools.
- **JSON numbers with "careful" parsing**: one forgotten `JSON.parse` reintroduces floats silently.
- **`money` column type in PostgreSQL**: depends on the `lc_monetary` locale and carries no currency.

## Consequences

- Every new monetary field must use `DecimalString`/`Money` in `libs/contracts`; the contract tests reject numbers.
- Arithmetic is slightly more verbose (`toCents(a) <= limit`) — the price of exactness.
- Multi-currency with three-decimal currencies would need a per-currency scale; out of scope for v1 (the allow-list only has two-decimal or zero-decimal currencies used as two-decimal values).
