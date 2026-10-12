const SENSITIVE_KEYS = ['pan', 'cvv', 'card', 'password', 'authorization', 'cookie', 'x-api-key'];

const depth = (path: string): number => path.split(/\.|\[/).length;

/**
 * pino `redact` paths (SPEC §7). pino wildcards match exactly one level, so each key is
 * listed at the top level and up to three levels deep, which covers request bodies,
 * `req.headers.*` and nested DTOs.
 *
 * Order matters: pino censors in place and restores afterwards, and when a child path
 * (`*.*.pan`) comes before an overlapping parent path (`*.card`), the restore leaves the
 * censor value in the caller's object, corrupting the data that was logged. Sorting shallow
 * paths first avoids it; a regression test in libs/observability guards this.
 */
export const REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => {
  const prop = /^[a-z]+$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) =>
    prop.startsWith('[') ? `${prefix}${prop}` : `${prefix}.${prop}`;
  return [prop.startsWith('[') ? prop : key, join('*'), join('*.*'), join('*.*.*')];
}).sort((a, b) => depth(a) - depth(b));

export const REDACTED = '[Redacted]';
