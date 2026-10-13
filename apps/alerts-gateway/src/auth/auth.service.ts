import { randomUUID } from 'node:crypto';
import { withTransaction, type Pool } from '@fraudstream/db';
import { afterFailure, afterSuccess, isLocked } from '../domain/lockout.js';
import { ANONYMOUS, type AuditRepository } from '../infrastructure/db/audit.repository.js';
import type { UsersRepository } from '../infrastructure/db/users.repository.js';
import { dummyHash, verifyPassword } from './passwords.js';
import { hashRefreshToken, newRefreshToken, type Principal, type TokenService } from './tokens.js';

export class InvalidCredentialsError extends Error {}
export class AccountLockedError extends Error {}
export class InvalidRefreshTokenError extends Error {}

export interface Session {
  principal: Principal;
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly users: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly tokens: TokenService,
    private readonly refreshTtlMs: number,
  ) {}

  /**
   * SPEC §6.8 / §7 Req. 8. The password is always verified, also for unknown emails (against a
   * dummy hash) and locked accounts, so response time does not reveal which case applies.
   * Unknown email and wrong password give the same error. A locked account answers 423 until
   * the lock expires, even with the right password: that reveals the account exists after 5
   * failures, which we accept in exchange for telling a real user why they cannot log in.
   */
  async login(email: string, password: string, ipHash: string): Promise<Session> {
    const outcome = await withTransaction(this.pool, async (tx) => {
      const now = new Date();
      const user = await this.users.findForLogin(tx, email);
      const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash()), password);
      if (!user) {
        await this.audit.record(tx, {
          actorId: ANONYMOUS,
          action: 'LOGIN_FAILED',
          targetType: 'user',
          targetId: 'unknown', // the submitted email is not stored
          ipHash,
        });
        return { kind: 'invalid' as const };
      }
      const state = { failedLogins: user.failedLogins, lockedUntil: user.lockedUntil };
      if (isLocked(state, now)) {
        await this.audit.record(tx, {
          actorId: user.userId,
          action: 'LOGIN_LOCKED',
          targetType: 'user',
          targetId: user.userId,
          ipHash,
        });
        return { kind: 'locked' as const };
      }
      if (!ok) {
        const next = afterFailure(state, now);
        await this.users.saveLoginState(tx, user.userId, next);
        await this.audit.record(tx, {
          actorId: user.userId,
          action: 'LOGIN_FAILED',
          targetType: 'user',
          targetId: user.userId,
          metadata: { failedLogins: next.failedLogins, locked: isLocked(next, now) },
          ipHash,
        });
        return { kind: 'invalid' as const };
      }
      await this.users.saveLoginState(tx, user.userId, afterSuccess());
      await this.audit.record(tx, {
        actorId: user.userId,
        action: 'LOGIN',
        targetType: 'user',
        targetId: user.userId,
        ipHash,
      });
      const principal: Principal = { userId: user.userId, email: user.email, role: user.role };
      const refreshToken = await this.issueRefresh(tx, principal.userId, randomUUID());
      return { kind: 'ok' as const, principal, refreshToken };
    });
    if (outcome.kind === 'invalid') throw new InvalidCredentialsError();
    if (outcome.kind === 'locked') throw new AccountLockedError();
    return {
      principal: outcome.principal,
      accessToken: await this.tokens.signAccess(outcome.principal),
      refreshToken: outcome.refreshToken,
    };
  }

  /**
   * Rotation: the presented token is revoked and a new one of the same family issued. A token
   * that is already revoked was used twice, so someone else may hold the family: the whole
   * family is revoked and the request fails (reuse detection).
   */
  async refresh(refreshToken: string, ipHash: string): Promise<Session> {
    const tokenHash = hashRefreshToken(refreshToken);
    const outcome = await withTransaction(this.pool, async (tx) => {
      const row = await this.users.findRefreshForUpdate(tx, tokenHash);
      if (!row) return null;
      if (row.revokedAt !== null) {
        const revoked = await this.users.revokeFamily(tx, row.familyId);
        await this.audit.record(tx, {
          actorId: row.userId,
          action: 'TOKEN_REUSE_DETECTED',
          targetType: 'refresh_token_family',
          targetId: row.familyId,
          metadata: { revoked },
          ipHash,
        });
        return null;
      }
      if (row.expiresAt.getTime() <= Date.now()) return null;
      await this.users.revokeToken(tx, tokenHash);
      const principal: Principal = { userId: row.userId, email: row.email, role: row.role };
      return { principal, refreshToken: await this.issueRefresh(tx, row.userId, row.familyId) };
    });
    if (!outcome) throw new InvalidRefreshTokenError();
    return { ...outcome, accessToken: await this.tokens.signAccess(outcome.principal) };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.users.revokeToken(this.pool, hashRefreshToken(refreshToken));
  }

  private async issueRefresh(
    tx: Parameters<UsersRepository['insertRefresh']>[0],
    userId: string,
    familyId: string,
  ): Promise<string> {
    const token = newRefreshToken();
    await this.users.insertRefresh(tx, {
      tokenHash: hashRefreshToken(token),
      userId,
      familyId,
      expiresAt: new Date(Date.now() + this.refreshTtlMs),
    });
    return token;
  }
}
