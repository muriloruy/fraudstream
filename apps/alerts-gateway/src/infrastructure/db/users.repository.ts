import type { Pool, PoolClient } from '@fraudstream/db';
import type { Role } from '../../auth/tokens.js';

type Db = Pick<PoolClient, 'query'>;

export interface UserRow {
  userId: string;
  email: string;
  passwordHash: string;
  role: Role;
  failedLogins: number;
  lockedUntil: Date | null;
}

export interface RefreshRow {
  userId: string;
  email: string;
  role: Role;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** auth.users and auth.refresh_tokens (SPEC §5.7). Names are schema-qualified: alerts_svc's search_path is alerts, auth. */
export class UsersRepository {
  /** Row-locked so concurrent attempts on one account count every failure (lockout). */
  async findForLogin(db: Db, email: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>(
      `SELECT user_id AS "userId", email::text AS email, password_hash AS "passwordHash", role,
              failed_logins AS "failedLogins", locked_until AS "lockedUntil"
         FROM auth.users WHERE email = $1 FOR UPDATE`,
      [email],
    );
    return rows[0] ?? null;
  }

  async saveLoginState(
    db: Db,
    userId: string,
    state: { failedLogins: number; lockedUntil: Date | null },
  ): Promise<void> {
    await db.query(
      'UPDATE auth.users SET failed_logins = $2, locked_until = $3 WHERE user_id = $1',
      [userId, state.failedLogins, state.lockedUntil],
    );
  }

  async upsertUser(
    pool: Pool,
    u: { userId: string; email: string; passwordHash: string; role: Role },
  ) {
    await pool.query(
      `INSERT INTO auth.users (user_id, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
         failed_logins = 0, locked_until = NULL`,
      [u.userId, u.email, u.passwordHash, u.role],
    );
  }

  async insertRefresh(
    db: Db,
    t: { tokenHash: string; userId: string; familyId: string; expiresAt: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO auth.refresh_tokens (token_hash, user_id, family_id, expires_at) VALUES ($1, $2, $3, $4)`,
      [t.tokenHash, t.userId, t.familyId, t.expiresAt],
    );
  }

  async findRefreshForUpdate(db: Db, tokenHash: string): Promise<RefreshRow | null> {
    const { rows } = await db.query<RefreshRow>(
      `SELECT t.user_id AS "userId", u.email::text AS email, u.role, t.family_id AS "familyId",
              t.expires_at AS "expiresAt", t.revoked_at AS "revokedAt"
         FROM auth.refresh_tokens t JOIN auth.users u USING (user_id)
        WHERE t.token_hash = $1 FOR UPDATE OF t`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async revokeToken(db: Db, tokenHash: string): Promise<void> {
    await db.query(
      'UPDATE auth.refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
  }

  async revokeFamily(db: Db, familyId: string): Promise<number> {
    const { rowCount } = await db.query(
      'UPDATE auth.refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId],
    );
    return rowCount ?? 0;
  }

  async purgeExpired(pool: Pool): Promise<number> {
    const { rowCount } = await pool.query(
      "DELETE FROM auth.refresh_tokens WHERE expires_at < now() - interval '1 day'",
    );
    return rowCount ?? 0;
  }
}
