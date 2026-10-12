-- Up Migration
-- Card vault (SPEC §5.2). The PAN is stored only as AES-256-GCM ciphertext; the CVV is
-- never stored, not even encrypted (PCI DSS 3.3.1).
CREATE TABLE cards (
  card_token     text        PRIMARY KEY,           -- 'tok_' + 32 random bytes base62
  pan_ciphertext bytea       NOT NULL,              -- AES-256-GCM, AAD = card_token
  pan_iv         bytea       NOT NULL CHECK (length(pan_iv) = 12),  -- unique per encryption
  pan_auth_tag   bytea       NOT NULL CHECK (length(pan_auth_tag) = 16),
  pan_hmac       char(64)    NOT NULL,              -- HMAC-SHA256(pan, hmacKey) for dedup lookup
  key_version    int         NOT NULL CHECK (key_version > 0),  -- supports key rotation
  bin            char(6)     NOT NULL,
  last4          char(4)     NOT NULL,
  expiry_month   smallint    NOT NULL CHECK (expiry_month BETWEEN 1 AND 12),
  expiry_year    smallint    NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Query: tokenize looks the card up by HMAC (same card = same token). There is no index on
-- the ciphertext: it is never searched.
CREATE UNIQUE INDEX cards_pan_hmac_key ON cards (pan_hmac);
-- Query: `pnpm vault:rotate` scans rows still encrypted with an old key version.
CREATE INDEX cards_key_version_idx ON cards (key_version);

-- Append-only record of detokenization attempts, allowed or denied (SPEC §6.2, PCI DSS 10).
CREATE TABLE audit_log (
  id          bigserial   PRIMARY KEY,
  actor_role  text        NOT NULL,
  action      text        NOT NULL CHECK (action IN ('DETOKENIZE')),
  card_token  text        NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN ('ALLOWED', 'DENIED', 'NOT_FOUND')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The service role may only append to the audit log.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM CURRENT_USER;

-- Down Migration
DROP TABLE audit_log;
DROP TABLE cards;
