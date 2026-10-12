/**
 * Error taxonomy of the consumer runtime (SPEC §4.6).
 *
 * - Transient: may succeed if retried (DB connection lost, timeout, deadlock, serialization
 *   failure). Retried in process, then through the retry topic, then sent to the DLQ.
 * - Permanent: retrying cannot help (schema validation, unknown event version, broken
 *   business invariant). Sent straight to the DLQ.
 *
 * Unknown errors are treated as transient: they end up in the DLQ after the retries instead
 * of being dropped or blocking the partition.
 */
export class TransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientError';
  }
}

export type PermanentReason = 'schema-validation' | 'unknown-event' | 'invariant';

export class PermanentError extends Error {
  constructor(
    readonly reason: PermanentReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/** PostgreSQL SQLSTATEs worth retrying: connection, serialization, deadlock, resources. */
const TRANSIENT_SQLSTATE = /^(08|40001|40P01|53|55P03|57P0[1-3]|58)/;
const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

export type ErrorClass = 'transient' | 'permanent';

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof PermanentError) return 'permanent';
  if (error instanceof TransientError) return 'transient';
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (typeof code === 'string') {
    if (TRANSIENT_NODE_CODES.has(code) || TRANSIENT_SQLSTATE.test(code)) return 'transient';
    // Integrity constraint violations (23xxx) mean the event contradicts stored state.
    if (code.startsWith('23')) return 'permanent';
  }
  return 'transient';
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1000);
  return String(error).slice(0, 1000);
}
