# card-tokenization Specification

## Purpose
Isolates cardholder data in a single internal service that turns a PAN into a stable token, encrypts it at rest with versioned keys, and tightly controls any reverse lookup.

## Requirements

### Requirement: Tokenize a PAN
The vault SHALL expose `POST /internal/tokenize` that accepts a PAN and expiry and returns `cardToken` (`tok_` + 32 random bytes base62), `maskedPan` (first 6 / last 4), `bin` and `last4` (SPEC §6.2).

#### Scenario: New card
- **WHEN** a valid, previously unseen PAN is tokenized
- **THEN** the response contains a new `cardToken`, `maskedPan` `411111******1111` for PAN `4111111111111111`, and one row is stored

#### Scenario: Same card returns same token
- **WHEN** the same PAN is tokenized twice
- **THEN** both responses return the same `cardToken` and only one row exists

### Requirement: Encryption at rest
The vault SHALL store the PAN only as AES-256-GCM ciphertext with a unique random 12-byte IV and auth tag per row, plus an HMAC-SHA256 used for lookup; the CVV SHALL never be stored (SPEC §5.2).

#### Scenario: Plaintext absent from storage
- **WHEN** the `vault.cards` table is dumped after tokenizing a PAN
- **THEN** the PAN does not appear in the dump and no column holds a CVV

#### Scenario: Tampered ciphertext detected
- **WHEN** a stored ciphertext or auth tag is altered and decryption is attempted
- **THEN** decryption fails with an integrity error

### Requirement: Key versioning and rotation
Each stored card SHALL record the `key_version` used, and a rotation command SHALL re-encrypt every row with the newest key without changing tokens (SPEC §6.2, §7 Req. 3.6/3.7).

#### Scenario: Rotation keeps tokens
- **WHEN** `pnpm vault:rotate` runs after `VAULT_DEK_V2` is configured
- **THEN** every row has `key_version = 2`, tokens are unchanged, and each PAN still decrypts to the original

### Requirement: Restricted detokenization
`POST /internal/detokenize` SHALL be allowed only for the `vault-admin` role and every call SHALL be audited; all other callers SHALL be rejected (SPEC §6.2).

#### Scenario: Service token cannot detokenize
- **WHEN** `transaction-api` calls detokenize with the shared service token
- **THEN** the vault returns 403 and records the denied attempt

### Requirement: Internal-only access
The vault SHALL not be reachable from the host network and SHALL reject requests without the shared service token (SPEC §6.2).

#### Scenario: Missing service token
- **WHEN** a request to `/internal/tokenize` has no service token
- **THEN** the vault returns 401
