import { createHmac, timingSafeEqual } from 'node:crypto';

/** Position in the alert queue: ORDER BY final_score DESC, created_at, alert_id. */
export interface QueueCursor {
  finalScore: string; // numeric(5,4) as text, compared in SQL, never as a float
  createdAt: string; // ISO timestamp with microseconds as stored
  alertId: string;
}

const SCORE = /^[01]\.\d{4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/**
 * Opaque keyset cursor: base64url(JSON) + "." + base64url(HMAC-SHA256). Clients cannot forge a
 * position or smuggle values into the query; a tampered cursor is rejected (400).
 */
export function encodeCursor(cursor: QueueCursor, key: Buffer): string {
  const body = Buffer.from(JSON.stringify([cursor.finalScore, cursor.createdAt, cursor.alertId]));
  const mac = createHmac('sha256', key).update(body).digest();
  return `${body.toString('base64url')}.${mac.toString('base64url')}`;
}

export function decodeCursor(token: string, key: Buffer): QueueCursor {
  const [bodyPart, macPart, extra] = token.split('.');
  if (!bodyPart || !macPart || extra !== undefined || token.length > 512) {
    throw new InvalidCursorError();
  }
  const body = Buffer.from(bodyPart, 'base64url');
  const mac = Buffer.from(macPart, 'base64url');
  const expected = createHmac('sha256', key).update(body).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new InvalidCursorError();
  const [finalScore, createdAt, alertId] = parsed as unknown[];
  if (
    typeof finalScore !== 'string' ||
    !SCORE.test(finalScore) ||
    typeof createdAt !== 'string' ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof alertId !== 'string' ||
    !UUID.test(alertId)
  ) {
    throw new InvalidCursorError();
  }
  return { finalScore, createdAt, alertId };
}
