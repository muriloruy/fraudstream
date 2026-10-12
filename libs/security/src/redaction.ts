const SENSITIVE_KEYS = ['pan', 'cvv', 'card', 'password', 'authorization', 'cookie', 'x-api-key'];

/**
 * pino `redact` paths (SPEC §7). pino wildcards match exactly one level, so each key is
 * listed at the top level and up to three levels deep, which covers request bodies,
 * `req.headers.*` and nested DTOs.
 */
export const REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => {
  const prop = /^[a-z]+$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) =>
    prop.startsWith('[') ? `${prefix}${prop}` : `${prefix}.${prop}`;
  return [prop.startsWith('[') ? prop : key, join('*'), join('*.*'), join('*.*.*')];
});

export const REDACTED = '[Redacted]';
