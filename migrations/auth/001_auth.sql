-- Up Migration
-- Analyst authentication (SPEC §5.7, §6.8, §7 Req. 8). citext lives in this schema (init-roles.sql).

CREATE TABLE users (
  user_id       uuid        PRIMARY KEY,
  email         citext      NOT NULL UNIQUE,
  password_hash text        NOT NULL,              -- argon2id (PHC string)
  role          text        NOT NULL CHECK (role IN ('analyst','admin')),
  failed_logins int         NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens are stored hashed. Every login starts a family; each rotation adds a token to
-- it and revokes the previous one. Presenting a revoked token means it was stolen or replayed,
-- so the whole family is revoked (reuse detection).
CREATE TABLE refresh_tokens (
  token_hash char(64)    PRIMARY KEY,               -- sha256 hex of the 32-byte random token
  user_id    uuid        NOT NULL REFERENCES users,
  family_id  uuid        NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Query: reuse detection "UPDATE ... SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL".
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
-- Query: hourly purge "DELETE ... WHERE expires_at < now() - interval '1 day'".
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- Down Migration
DROP TABLE refresh_tokens;
DROP TABLE users;
