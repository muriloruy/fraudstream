import type { PoolClient } from '@fraudstream/db';

type Db = Pick<PoolClient, 'query'>;

export const ANONYMOUS = '00000000-0000-0000-0000-000000000000';

export type AuditAction =
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGIN_LOCKED'
  | 'TOKEN_REUSE_DETECTED'
  | 'ALERT_VIEWED'
  | 'ALERT_ASSIGNED'
  | 'ALERT_RESOLVED'
  | 'DLQ_REPLAYED';

export interface AuditEntry {
  actorId: string;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

/** `alerts.audit_log` is append-only for alerts_svc (REVOKE UPDATE, DELETE in the migration). */
export class AuditRepository {
  async record(db: Db, e: AuditEntry): Promise<void> {
    await db.query(
      `INSERT INTO alerts.audit_log (actor_id, action, target_type, target_id, metadata, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        e.actorId,
        e.action,
        e.targetType,
        e.targetId,
        JSON.stringify(e.metadata ?? {}),
        e.ipHash ?? null,
      ],
    );
  }
}
