# ADR-008: Tokenization vault design

- **Status:** accepted
- **Date:** 2026-10-12
- **Milestone:** M1 (SPEC §5.2, §6.2, §7)

## Context

PCI DSS applies to every system that stores, processes or transmits cardholder data, and to everything connected to them. The cheapest control is to keep the PAN out of almost every system. The platform still needs a stable card identifier (velocity per card, ledger, investigations) and, rarely, a controlled way back to the PAN.

## Decision

A single internal service, `card-vault`, is the only component that ever sees a PAN.

- **Tokenization.** `POST /internal/tokenize` returns `cardToken` (`tok_` + 32 random bytes in base62), `maskedPan` (first 6 / last 4), `bin`, `last4`. The token is random, so it reveals nothing about the PAN. `transaction-api` discards the PAN right after the call; Kafka events, other schemas and logs only ever carry the token and the masked PAN.
- **Same card, same token.** Lookup is by `pan_hmac = HMAC-SHA256(PAN, VAULT_HMAC_KEY)` with a unique index. A keyed HMAC instead of a plain hash: a SHA-256 of a 16-digit PAN with a known BIN can be brute-forced. Concurrent first requests race on the unique index (`ON CONFLICT DO NOTHING`) and the loser returns the winner's token.
- **Encryption at rest.** AES-256-GCM via Node `crypto`, a random 96-bit IV per encryption, a 128-bit auth tag, and the card token as additional authenticated data. The AAD binds a ciphertext to its row: copying a ciphertext onto another token makes decryption fail.
- **Key management (simulated KMS).** Data-encryption keys come from env (`VAULT_DEK_V1`, `VAULT_DEK_V2`, ...); each row records its `key_version`; the highest version (or `VAULT_ACTIVE_KEY_VERSION`) encrypts new cards. `pnpm vault:rotate` re-encrypts old rows in batches with `FOR UPDATE SKIP LOCKED` while traffic continues; tokens never change. Keys are never in the repository; `pnpm env:init` generates local ones.
- **CVV is never stored**, not even encrypted (PCI DSS 3.3.1). It is validated by `transaction-api` and dropped.
- **Detokenization** exists to demonstrate the control: only the `vault-admin` token may call it, every attempt (allowed, denied, not found) goes to the append-only `vault.audit_log`, and no service calls it.
- **Network and identity.** No published port in compose; callers present a bearer token (`VAULT_SERVICE_TOKEN`) compared in constant time. mTLS is a stretch goal.
- **Memory hygiene.** The vault copies the PAN into a `Buffer` and zeroes it after use. JSON parsing already created an immutable JS string that we cannot wipe; that copy lives until garbage collection. A production vault would parse the body without materializing strings (or run in an HSM).

## Alternatives considered

- **Format-preserving encryption in place** (encrypted PAN stored by each service): every service would hold key material and be in PCI scope.
- **Deterministic encryption as the token**: links tokens to keys, so key rotation would change tokens and break history.
- **External vault (HashiCorp Vault transit, cloud KMS/HSM)**: the production answer, but requires infrastructure beyond `docker compose up` (SPEC §0).

## Consequences

- Only `card-vault` and the `vault` schema are in cardholder-data scope; `pnpm test:security` proves the PAN appears nowhere else (logs, topics, other schemas, API responses).
- The HMAC key cannot be rotated without recomputing every `pan_hmac` (which requires decrypting each PAN); this is a separate, rarer procedure than DEK rotation.
- The vault is on the synchronous path of every authorization: its latency and availability bound `transaction-api` (503 when it is down).
